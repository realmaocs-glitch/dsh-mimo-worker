// ============================================================
// dsh-mimo-worker —— 模型路由执行 worker
//
// 职责划分：
//   · 主对话模型（界面里选什么就是什么，插件完全不碰）只做
//     规划 / 推理 / 最终验收；
//   · 执行（读文件、改代码、跑命令、编译、测试）由本插件注册的
//     `model_route` 工具路由到配置指定模型的 worker 子代理完成。
//
// 机制（均已对照本机 DSH 源码验证）：
//   1. spawn 子代理创建时默认继承父 agent 的 provider/model，但
//      SubagentStartRequest.agentOptions 可显式覆盖
//      → 我们用配置强制定向到 worker 模型（默认 xiaomi/mimo-v2.5）。
//   2. 子代理通过 applyChildComposition 加入父级 preset，获得整套执行
//      工具（fs 读写/编辑、bash、后台 jobs、glob/grep），运行在 DSH
//      沙箱内；子代理审批策略固定 'never'，无法自我批准。
//   3. spawn provider 支持 outputSchema（structured_output 强制结构化
//      报告收尾）、persona（worker 人设）、toolFilter（工具过滤）、
//      maxDepth（递归上限）。
//   4. `job_output` / `job_kill` / `send_message` 等工具由宿主提供，
//      后台模式直接复用 jobs 服务的 subagent 任务槽。
//
// 零外部依赖：profile node_modules 只装用户插件，不 import 任何
// @deepseek-ai 内部包。工具按 dsh-tools 的 raw ToolDefinition 形态
// 手工构造（parameters / output.schema 均为标准 JSON Schema，
// 不含作者态关键字如 type:"json"）。
// ============================================================

export const name = "model-route";
export const inject = ["tools", "subagents"];

const DEFAULT_PROVIDER_NAME = "spawn";
const DEFAULT_TOOL_NAME = "model_route";
const DEFAULT_PROVIDER = "meituan";
const DEFAULT_MODEL = "LongCat-2.0";
// LongCat-2.0 输出上限 8192；换回 MiMo（131K）时记得调回 32768+，或让配置显式指定
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_LABEL_PREFIX = "model_route";

// worker 默认禁用的工具：防委派递归与反问（需要放开请在配置里给 toolFilter）
const DEFAULT_DENY = ["subagent", "subagent_fork", "workflow", "ask_user_question"];
const DELEGATION_TOOLS = ["subagent", "subagent_fork", "workflow", "model_route"];

const DEFAULT_PERSONA = `你是 DSH 的「执行 worker」。你的职责是执行，不是规划：把给定任务真正做完 —— 读文件、写/改代码、运行命令、编译、测试。

要求：
1. 直接动手干活。不要复述任务，不要先长篇讲方案；需要信息就读文件，需要改动就改，需要验证就跑命令。
2. 你无法向用户提问，也无法自我批准任何需要审批的操作。遇到硬阻塞（依赖缺失、权限不足、歧义到无法执行），在报告的 notes 里写清原因并把 status 置为 blocked，然后立刻提交报告。
3. 记录关键动作：改动的文件路径、运行的命令及其关键输出、测试/编译结果。
4. 全部完成后调用 structured_output 提交结构化报告：
   - status: done（全部完成）/ partial（部分完成）/ blocked（硬阻塞）
   - summary: 结论（做了哪些改动、如何验证）
   - changedFiles: 修改/新增的文件路径列表
   - evidence: 测试/编译/命令的关键输出片段
   - notes: 遗留事项、阻塞原因、需要主对话注意的东西（没有就留空字符串）
5. 报告要精炼且可验收：主对话只凭报告就能判断任务完成情况。
6. 工作区整洁：任务过程中自建的临时文件（临时脚本、中间提取/清洗文件等）在提交报告前自行删除，只保留最终交付物；绝不要删除用户的既有文件或任务要求的产出物，拿不准就保留并在 notes 里说明。
7. 高效执行：一次派单只干一件事，能用一条命令内聚完成就不要拆多条；少输出过程日志，只在 evidence 保留关键输出；发现任务超出能力或合理时间预算（比如某一步反复失败、命令长时间无响应），立刻停止并报 blocked，附上已完成的中间产出，不要反复重试同一招。`;

// worker 结构化报告 schema（子代理 structured_output 强制，字段不可增删）
export const WORKER_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "changedFiles", "evidence"],
  properties: {
    status: { type: "string", enum: ["done", "partial", "blocked"] },
    summary: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" } },
    notes: { type: "string" }
  }
};

// ---------- 小工具 ----------

function truncate(text, max) {
  const t = String(text).replace(/\s+/gu, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function textOnly(output) {
  if (!Array.isArray(output)) return "";
  return output
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/** 非 completed 的停止原因 → 报错文案（仿 @deepseek-ai/dsh-tool-subagent）。 */
function stopReasonError(result) {
  switch (result.stopReason) {
    case "completed": return void 0;
    case "aborted": return "model_route 运行被取消";
    case "error": return "model_route 执行失败（worker 可能未按要求调用 structured_output 提交报告）";
    case "max-tokens": return "model_route 达到 token 上限提前结束";
    case "refusal": return "worker 拒绝了任务";
    default: return `model_route 异常结束 (${String(result.stopReason)})`;
  }
}

function withPartialText(error, output) {
  const text = textOnly(output);
  return text.length === 0 ? error : `${error}\n结束前未完成的输出片段：\n${text}`;
}

// ---------- worker 提示词 ----------

function workerPrompt(task, context) {
  const lines = [
    "你是一个「执行 worker」。你的职责是执行，不是规划：把下面的任务真正做完 —— 读文件、写/改代码、运行命令、编译、测试。",
    "",
    "要求：",
    "1. 直接动手干活，不要复述任务，不要先讲方案；需要信息就读文件，需要改动就改，需要验证就跑命令。",
    "2. 你无法向用户提问，也无法自我批准任何需要审批的操作。遇到硬阻塞（依赖缺失、权限不足、歧义到无法执行），在报告的 notes 里写清原因并把 status 置为 blocked，然后立刻提交报告。",
    "3. 记录关键动作：改动的文件路径、运行的命令及其关键输出、测试/编译结果。",
    "4. 全部完成后调用 structured_output 提交结构化报告：",
    "   - status: done（全部完成）/ partial（部分完成）/ blocked（硬阻塞）",
    "   - summary: 结论（做了哪些改动、如何验证）",
    "   - changedFiles: 修改/新增的文件路径列表",
    "   - evidence: 测试/编译/命令的关键输出片段",
    "   - notes: 遗留事项、阻塞原因、需要主对话注意的东西（没有就留空字符串）",
    "5. 报告要精炼且可验收：主对话只凭报告就能判断任务完成情况。",
    "",
    `任务：\n${String(task)}`
  ];
  if (context !== void 0 && String(context).trim().length > 0) {
    lines.push("", `补充背景/约束：\n${String(context)}`);
  }
  return lines.join("\n");
}

// ---------- 前台 / 后台收尾（零依赖复刻 dsh-tool-subagent 的收尾逻辑） ----------

async function settleForeground(run, modelLabel) {
  const [execution] = await Promise.allSettled([run.result.then((result) => {
    const error = stopReasonError(result);
    if (error !== void 0) throw new Error(withPartialText(error, result.output));
    return {
      ok: true,
      model: modelLabel,
      stopReason: result.stopReason,
      report: result.structured ?? null,
      outputText: textOnly(result.output)
    };
  })]);
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
  if (execution.status === "rejected") {
    if (disposal.status === "rejected") {
      throw new AggregateError([execution.reason, disposal.reason], `model_route 子代理失败: ${String(execution.reason)}；清理也失败: ${String(disposal.reason)}`);
    }
    throw execution.reason;
  }
  if (disposal.status === "rejected") throw disposal.reason;
  return execution.value;
}

async function settleBackground(startPromise, signal) {
  let outcome;
  try {
    const run = await startPromise;
    const result = await run.result;
    outcome = { stop: result.stopReason, report: result.structured ?? null, outputText: textOnly(result.output) };
    try {
      await run.dispose();
    } catch { /* 清理失败不吞掉结果状态 */ }
  } catch (error) {
    return signal.aborted ? { status: "killed" } : { status: "failed", detail: String(error) };
  }
  return {
    status: outcome.stop === "completed" ? "completed" : "failed",
    detail: outcome.stop,
    report: outcome.report,
    outputText: outcome.outputText
  };
}

// ---------- 工具定义（raw ToolDefinition，零 import） ----------

function buildTool(ctx, o) {
  return {
    name: o.toolName,
    description: `把「执行类任务」路由给 worker 子代理（当前模型 ${o.provider}/${o.model}）去真正做完：读文件、写/改代码、运行命令、编译、测试。worker 在 DSH 沙箱内执行（不能自我批准需要审批的操作），完成后返回结构化报告 {status, summary, changedFiles, evidence, notes}。规划、推理与最终验收由你负责：派任务时写明目标和验收标准；收到报告后核对 status / changedFiles / evidence 验收。若 status=blocked 表示确有硬阻塞（缺依赖/权限/歧义），结合 notes 决定补充信息重派或改由自己处理。执行类任务都优先交给它，省主模型 token。`,
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "要交给 worker 执行的完整任务：目标、验收标准、涉及的文件/命令/测试。"
        },
        context: {
          type: "string",
          description: "可选补充背景：已有代码结构说明、报错日志、约束条件等。"
        },
        run_in_background: {
          type: "boolean",
          description: "true 时后台执行并返回 jobId（用 job_output 收集、job_kill 停止），适合长编译/长测试；缺省/为 false 时前台等待结果。"
        }
      },
      required: ["task"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          ok: { type: "boolean" },
          kind: { type: "string" },
          jobId: { type: "string" },
          model: { type: "string" },
          stopReason: { type: "string" },
          report: { type: "object", additionalProperties: true },
          outputText: { type: "string" },
          error: { type: "string" }
        }
      },
      // 展示用，永不抛错
      render(_args, value) {
        const lines = [];
        if (value.kind === "background") {
          lines.push(`🚀 model_route 后台任务已启动: ${String(value.jobId)}（job_output 收集 / job_kill 停止）`);
          return [{ type: "text", text: lines.join("\n") }];
        }
        const model = typeof value.model === "string" ? value.model : "?";
        if (value.ok === true) {
          lines.push(`✅ model_route(${model}) ${String(value.stopReason ?? "completed")}`);
        } else {
          lines.push(`❌ model_route(${model}) ${String(value.stopReason ?? "failed")}${typeof value.error === "string" ? `: ${value.error}` : ""}`);
        }
        const report = value.report;
        if (report !== null && typeof report === "object") {
          if (Array.isArray(report.changedFiles)) {
            lines.push(`📁 修改文件 (${report.changedFiles.length}): ${report.changedFiles.join(", ")}`);
          }
          if (typeof report.status === "string") lines.push(`状态: ${report.status}`);
          if (typeof report.summary === "string" && report.summary.length > 0) lines.push(report.summary);
          if (Array.isArray(report.evidence) && report.evidence.length > 0) {
            lines.push("--- 证据片段 ---");
            for (const ev of report.evidence.slice(0, 5)) lines.push(String(ev).slice(0, 500));
          }
          if (typeof report.notes === "string" && report.notes.length > 0) lines.push(`📌 notes: ${report.notes}`);
        }
        if (typeof value.outputText === "string" && value.outputText.length > 0) {
          lines.push("--- worker 最终文本 ---");
          lines.push(value.outputText.slice(0, 3000));
        }
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error(`${o.toolName}: 需要调用方 agent`);

      const request = {
        label: `${o.labelPrefix}: ${truncate(args.task, 80)}`,
        prompt: [{ type: "text", text: workerPrompt(args.task, args.context) }],
        parent,
        agentOptions: {
          provider: o.provider,
          model: o.model,
          ...(typeof o.maxTokens === "number" && o.maxTokens > 0 ? { maxTokens: o.maxTokens } : {})
        },
        ...(o.persona ? { persona: o.persona } : {}),
        ...(o.toolFilter ? { toolFilter: o.toolFilter } : {}),
        ...(typeof o.maxDepth === "number" && o.maxDepth >= 0 ? { maxDepth: o.maxDepth } : {}),
        outputSchema: WORKER_REPORT_SCHEMA,
        signal: exec.signal
      };
      const modelLabel = `${o.provider}/${o.model}`;

      if (args.run_in_background === true) {
        const jobs = ctx.get("jobs");
        if (jobs === void 0) throw new Error(`${o.toolName}: 后台任务不可用（jobs 服务未挂载）`);
        return {
          kind: "background",
          jobId: jobs.start({
            kind: "subagent",
            label: request.label,
            owner: parent,
            run: () => {
              const controller = new AbortController();
              return {
                cancel: (reason) => controller.abort(reason ?? "model_route job killed"),
                done: settleBackground(ctx.subagents.start(o.providerName, { ...request, signal: controller.signal }), controller.signal)
              };
            }
          })
        };
      }

      return settleForeground(await ctx.subagents.start(o.providerName, request), modelLabel);
    }
  };
}

// ---------- 插件入口 ----------

export function apply(ctx, config = {}) {
  const toolName = typeof config.toolName === "string" && config.toolName.trim().length > 0
    ? config.toolName.trim()
    : DEFAULT_TOOL_NAME;

  const o = {
    providerName: typeof config.providerName === "string" && config.providerName.trim().length > 0
      ? config.providerName.trim()
      : DEFAULT_PROVIDER_NAME,
    toolName,
    provider: typeof config.provider === "string" && config.provider.trim().length > 0
      ? config.provider.trim()
      : DEFAULT_PROVIDER,
    model: typeof config.model === "string" && config.model.trim().length > 0
      ? config.model.trim()
      : DEFAULT_MODEL,
    maxTokens: typeof config.maxTokens === "number" && Number.isFinite(config.maxTokens)
      ? config.maxTokens
      : DEFAULT_MAX_TOKENS,
    maxDepth: typeof config.maxDepth === "number" && Number.isFinite(config.maxDepth)
      ? config.maxDepth
      : DEFAULT_MAX_DEPTH,
    persona: typeof config.persona === "string" && config.persona.trim().length > 0
      ? config.persona
      : DEFAULT_PERSONA,
    labelPrefix: typeof config.labelPrefix === "string" && config.labelPrefix.trim().length > 0
      ? config.labelPrefix.trim()
      : DEFAULT_LABEL_PREFIX,
    toolFilter: (() => {
      const base = config.toolFilter !== void 0 && config.toolFilter !== null ? config.toolFilter : {};
      const deny = Array.isArray(base.deny) ? base.deny.slice() : [];
      return { ...base, deny: Array.from(new Set([...deny, ...DELEGATION_TOOLS, toolName])) };
    })()
  };

  const subagents = ctx.get("subagents");
  let disposeTool = void 0;

  const mount = (provider) => {
    if (disposeTool !== void 0) return;
    if (!provider || provider.name !== o.providerName) return;
    disposeTool = ctx.tools.register(buildTool(ctx, o));
  };

  ctx.on("subagent/provider-added", mount);
  ctx.on("subagent/provider-removed", (removedName) => {
    if (removedName !== o.providerName || disposeTool === void 0) return;
    disposeTool();
    disposeTool = void 0;
  });

  const present = subagents?.getProvider(o.providerName);
  if (present !== void 0) mount(present);

  return () => {
    if (disposeTool !== void 0) {
      disposeTool();
      disposeTool = void 0;
    }
  };
}