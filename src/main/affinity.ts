import { randomUUID } from 'node:crypto'
import type { AffinityEntry, AffinityState } from '@shared/types'
import { getCharacters } from './content'
import { JsonState, dataFile } from './store'
import { t } from '@shared/i18n'

/**
 * 好感度。学習の成果（ノートの評価、テスト、週ごとの評価）に応じて全員ぶん増え、
 * コミュニケーションモードで話しかけると、その相手のぶんだけ減る。
 * 0 になるとその相手には話しかけられなくなるが、相手の態度は変わらない（AI には値を伝えない）。
 */
/**
 * 2026-11 の仕様変更で、好感度はいったん廃止した（コミュニケーションモードをディベートモードに作りかえたため）。
 * 復活させるときに備えて仕組みは残し、ここを true にすれば再び増減するようにしてある。画面には出していない。
 */
const ENABLED = false

const MAX = 100
const INITIAL = 20
const TALK_COST = 2

interface Stored {
  gauges: Record<string, number>
  ledger: AffinityEntry[]
  /** ノートごとに、これまでに配った量（同じノートを何度見てもらっても、伸びた分しか増えない） */
  noteRewards: Record<string, number>
}

const state = new JsonState<Stored>(() => dataFile('affinity.json'), () => ({ gauges: {}, ledger: [], noteRewards: {} }))

const clamp = (value: number) => Math.max(0, Math.min(MAX, value))

function gauges(): Record<string, number> {
  const saved = state.get().gauges
  return Object.fromEntries(getCharacters().map((c) => [c.id, saved[c.id] ?? INITIAL]))
}

function record(characterId: string, delta: number, reason: string, next: Record<string, number>, extra: Partial<Stored> = {}): void {
  const entry: AffinityEntry = { id: randomUUID(), at: Date.now(), characterId, delta, reason }
  state.update((s) => ({ ...s, ...extra, gauges: next, ledger: [entry, ...s.ledger].slice(0, 200) }))
}

export function getAffinity(): AffinityState {
  return { gauges: gauges(), max: MAX, talkCost: TALK_COST, recent: state.get().ledger.slice(0, 30) }
}

/** 全員の好感度を増やす */
export function grantAll(delta: number, reason: string, extra: Partial<Stored> = {}): void {
  if (!ENABLED || delta <= 0) return
  const next = Object.fromEntries(Object.entries(gauges()).map(([id, value]) => [id, clamp(value + delta)]))
  record('all', delta, reason, next, extra)
}

export function canTalk(characterId: string): boolean {
  return (gauges()[characterId] ?? 0) >= TALK_COST
}

/** 話しかけたぶんを、その相手の好感度から使う */
export function spendForTalk(characterId: string, characterName: string): void {
  const current = gauges()
  record(characterId, -TALK_COST, t('{0}と話した', characterName), { ...current, [characterId]: clamp((current[characterId] ?? 0) - TALK_COST) })
}

/**
 * ノートの評価に応じて配る。3 つの観点の平均 10 点につき 1。
 * 同じノートでは、これまでの最高より伸びた分だけを配る。
 */
export function rewardNote(notebookId: string, title: string, average: number): number {
  if (!ENABLED) return 0
  const target = Math.round(average / 10)
  const given = state.get().noteRewards[notebookId] ?? 0
  const delta = Math.max(0, target - given)
  if (delta > 0) grantAll(delta, t('ノートの評価（{0}）', title), { noteRewards: { ...state.get().noteRewards, [notebookId]: target } })
  return delta
}

/** テストの点数に応じて配る。10 点につき 1。 */
export function rewardTest(unitTitle: string, score: number): number {
  if (!ENABLED) return 0
  const delta = Math.round(score / 10)
  grantAll(delta, t('テスト（{0}）{1} 点', unitTitle, score))
  return delta
}

/** 週ごとの評価が確定したときに配る。総合 5 点につき 1。 */
export function rewardWeek(label: string, overall: number): number {
  if (!ENABLED) return 0
  const delta = Math.round(overall / 5)
  grantAll(delta, t('{0}の評価', label))
  return delta
}
