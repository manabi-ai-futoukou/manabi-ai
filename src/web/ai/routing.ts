/**
 * 仕事（モード）ごとに、どのモデルに頼むか（Web 版）。ブラウザと、付属のサーバーの両方から使う。
 *
 * 軽いモデルで足りる仕事は軽いモデルに、手書きのノートを読むような仕事は上のモデルに回す。
 * 割り当ては、モデルごとの試し（tools/model-check.mjs。2026-11-19）をもとに決めたもの。試しで分かったこと:
 * - GPT-6 Luna は、くずれた手書きを読めなかった（読みとり 0.10）。手書きを読む仕事には Terra 以上を使う。Claude Haiku 5.5 は 0.90 読めた
 * - テストづくり・採点・英会話は、6 つのモデルのどれでも、ねらいどおりにできた
 * - 質問への返事は、どのモデルも内容は正しい。上のモデル（Sonnet・Opus・Terra）は問いかけて導き、軽いモデルは答えと理由をすぐに言う
 */
export type Task = 'chat' | 'note-eval' | 'transcribe' | 'vocab-check' | 'test-make' | 'test-grade' | 'debate' | 'eikaiwa' | 'kanji' | 'vocab-words' | 'report' | 'translate' | 'authoring' | 'other'

export const TASK_LABELS: Record<Task, string> = {
  chat: '授業についての質問（チャット）',
  'note-eval': 'ノートの評価（手書きを読む）',
  transcribe: '手書きの文字起こし',
  'vocab-check': '語彙力特訓の確かめ（手書きを読む）',
  'test-make': 'テストの問題づくり',
  'test-grade': 'テストの採点',
  debate: 'ディベート',
  eikaiwa: '英会話',
  kanji: '漢字特訓の言葉づくり',
  'vocab-words': '語彙力特訓の言葉づくり',
  report: '週ごとの評価のコメント',
  translate: '授業の翻訳',
  authoring: '授業づくり',
  other: 'そのほか',
}

/** 画面からの要求（チャンネル）→ 仕事の種類 */
export function taskOf(channel: string): Task {
  if (channel === 'chat:send' || channel === 'debate:coach') return 'chat'
  if (channel === 'notes:evaluate') return 'note-eval'
  if (channel === 'notes:transcribe') return 'transcribe'
  if (channel === 'vocab:check') return 'vocab-check'
  if (channel === 'vocab:start' || channel === 'vocab:skip') return 'vocab-words'
  if (channel === 'test:start' || channel === 'essay:make') return 'test-make'
  if (channel === 'essay:review') return 'note-eval'
  if (channel === 'annot:make') return 'authoring'
  if (channel === 'test:submit') return 'test-grade'
  if (channel.startsWith('debate:')) return 'debate'
  if (channel.startsWith('eikaiwa:')) return 'eikaiwa'
  if (channel.startsWith('kanji:')) return 'kanji'
  if (channel === 'report:comment') return 'report'
  if (channel === 'content:translate') return 'translate'
  if (channel.startsWith('content:') || channel.startsWith('library:')) return 'authoring'
  return 'other'
}

export interface Choice {
  model: string
  effort: string
}

/** 仕事ごとの割り当て（API のモデルの ID と、思考量） */
export const ROUTING: Record<Task, { claude: Choice; openai: Choice }> = {
  chat: { claude: { model: 'claude-haiku-5-5', effort: 'medium' }, openai: { model: 'gpt-6-luna', effort: 'medium' } },
  'note-eval': { claude: { model: 'claude-sonnet-5-5', effort: 'medium' }, openai: { model: 'gpt-6.1-terra', effort: 'medium' } },
  // 文字起こしは、読むだけの仕事。手書きを読めるモデルのうち、軽いものにする（Luna は、くずれた手書きを読めない）
  transcribe: { claude: { model: 'claude-haiku-5-5', effort: 'low' }, openai: { model: 'gpt-6.1-terra', effort: 'low' } },
  'vocab-check': { claude: { model: 'claude-haiku-5-5', effort: 'medium' }, openai: { model: 'gpt-6.1-terra', effort: 'low' } },
  'test-make': { claude: { model: 'claude-sonnet-5-5', effort: 'medium' }, openai: { model: 'gpt-6.1-terra', effort: 'medium' } },
  'test-grade': { claude: { model: 'claude-haiku-5-5', effort: 'medium' }, openai: { model: 'gpt-6-luna', effort: 'medium' } },
  debate: { claude: { model: 'claude-haiku-5-5', effort: 'medium' }, openai: { model: 'gpt-6-luna', effort: 'medium' } },
  eikaiwa: { claude: { model: 'claude-haiku-5-5', effort: 'low' }, openai: { model: 'gpt-6-luna', effort: 'low' } },
  kanji: { claude: { model: 'claude-haiku-5-5', effort: 'low' }, openai: { model: 'gpt-6-luna', effort: 'low' } },
  'vocab-words': { claude: { model: 'claude-haiku-5-5', effort: 'low' }, openai: { model: 'gpt-6-luna', effort: 'low' } },
  report: { claude: { model: 'claude-haiku-5-5', effort: 'medium' }, openai: { model: 'gpt-6-luna', effort: 'medium' } },
  translate: { claude: { model: 'claude-sonnet-5-5', effort: 'low' }, openai: { model: 'gpt-6.2-sol', effort: 'low' } },
  authoring: { claude: { model: 'claude-sonnet-5-5', effort: 'medium' }, openai: { model: 'gpt-6.2-sol', effort: 'medium' } },
  other: { claude: { model: 'claude-haiku-5-5', effort: 'medium' }, openai: { model: 'gpt-6-luna', effort: 'medium' } },
}

export const routed = (task: Task, family: 'claude' | 'openai'): Choice => ROUTING[task]?.[family] ?? ROUTING.other[family]
