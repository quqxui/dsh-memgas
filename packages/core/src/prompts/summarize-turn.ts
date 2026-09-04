export const TURN_PROMPT_VERSION = 'summarize-turn@1'

export interface BuiltPrompt {
  system: string
  prompt: string
  version: string
}

/** Rules shared by every extractor: what counts as a memory and what never does. */
export const EXTRACTION_RULES = `只记录以下七类，其余一律丢弃：
- preference：用户对工作方式、回复风格、工具选择的偏好
- decision：做出的技术决定及其理由
- convention：项目约定（命名、目录结构、流程、提交规范）
- environment：环境事实（版本、路径、端口、服务地址等配置）
- pitfall：踩过的坑与规避方法
- entity：反复出现的关键对象（文件、模块、服务、外部系统）及其用途
- todo：明确留待以后做的事

规则：
1. 没有值得记的内容时，输出 {"summary":"","facts":[],"keywords":[]}。不要为了填充而编造。
2. 每条 fact 独立可读，不依赖上下文；写出具体的名字、路径、数值，不写「这个」「上面那个」。
3. stated_by：用户明确说的填 "user"；助手推断、建议或自行决定的填 "assistant"，其 confidence 不得超过 0.7。
4. 绝不记录：密钥、token、密码、私钥；一次性的中间值和临时报错；助手的推理过程；工具的原始输出；本轮已被推翻或撤回的内容。
5. 保留原语言，不翻译；中文对话产出中文。
6. keywords 只放精确标识符：文件路径、包名、命令、报错码、专有名词，原样保留大小写与标点，最多 15 个。
7. 只输出一个 JSON 对象。不要 Markdown 围栏，不要解释，不要前后缀。

输出格式：
{"summary": string, "facts": [{"kind": "preference|decision|convention|environment|pitfall|entity|todo", "content": string, "confidence": 0到1的数, "stated_by": "user"|"assistant"}], "keywords": [string]}`

const TURN_SYSTEM = `你是编码助手的长期记忆整理器。输入是用户与助手在一个编码会话里的一轮对话，输出是值得在以后的会话中回想起来的内容，严格 JSON。

summary 用一两句话说清这一轮做了什么、结论是什么；没有实质内容就留空字符串。

${EXTRACTION_RULES}`

export interface TurnPromptInput {
  transcript: string
  occurredAt: number
  cwd?: string
  gitBranch?: string
}

export function buildTurnPrompt(input: TurnPromptInput): BuiltPrompt {
  const context = [
    `时间：${new Date(input.occurredAt).toISOString()}`,
    input.cwd ? `工作目录：${input.cwd}` : null,
    input.gitBranch ? `git 分支：${input.gitBranch}` : null,
  ].filter(Boolean).join('\n')

  return {
    system: TURN_SYSTEM,
    prompt: `${context}\n\n对话记录：\n<<<\n${input.transcript}\n>>>`,
    version: TURN_PROMPT_VERSION,
  }
}
