import { SCHOOLS, type Course } from '@shared/types'
import { t, tx } from '@/lib/i18n'

/**
 * 高校の専門教科を開いたときに出す注意書き。
 *   職業に関する専門科目（農業、工業、商業、看護など）… 実習や資格の勉強の代わりにならないこと
 *   実技が中心の専門科目（体育、音楽、美術）           … 実技そのものは学べないこと
 * どちらでもない科目（理数、英語）には出さない。
 * 大学・大学院の科目には、試作であることと、専門家の確認を受けていないことを出す。
 */
export function FieldNote({ course }: { course: Course }) {
  if (course.higher) {
    return (
      <p className="notice notice-field">{t('大学・大学院の授業は、試作です。AI が作成したもので、その分野の専門家の確認を受けていません。大学には全国共通の学習内容の決まりが無いので、広く使われている教科書の組み立てを参考にしています。単位や資格のための勉強の代わりにはなりません。法律・心理・医療などの内容を、実際の判断に使わないでください。')}</p>
    )
  }
  if (course.skill) {
    return (
      <p className="notice notice-field">{tx('この科目は、知識や理論、練習や制作の考え方を学ぶためのものです。体を動かすこと・演奏・制作そのものは、このアプリでは学べません。{0}けがにつながる運動や、刃物・薬品・機械を使う制作は、必ず学校などで、指導者のもとで行ってください。', course.practice ? t('学校では課題研究として行う科目なので、ここでは進め方や考え方だけを扱います。') : '')}</p>
    )
  }
  if (!course.vocational) return null
  return (
    <p className="notice notice-field">{tx('この科目は、専門分野の知識を学ぶためのものです。{0}実習や、資格をとるための勉強の代わりにはなりません。けがや事故につながる作業は、必ず学校や職場で、指導者のもとで行ってください。{1}', course.practice ? t('学校では実習として行う科目なので、ここでは進め方や考え方だけを扱います。') : '', course.subject === 'nursing' ? t('病気や薬の説明は、一般的な理解のためのものです。体の具合が気になるときは、医療機関に相談してください。') : '')}
    </p>
  )
}

/** 学校を選び、その中の科目を教科ごとにまとめた一覧から選ぶ */
export function CoursePicker({
  courses,
  value,
  onChange,
  disabled,
  only,
}: {
  courses: Course[]
  value: string
  onChange: (courseId: string) => void
  disabled?: boolean
  /** 一覧に出す科目をしぼる（例: 本文がある科目だけ） */
  only?: (course: Course) => boolean
}) {
  const listed = only ? courses.filter(only) : courses
  const current = listed.find((c) => c.id === value) ?? listed[0]
  if (!current) return null
  const inSchool = listed.filter((c) => c.school === current.school)
  const subjects = [...new Set(inSchool.map((c) => c.subjectLabel))]

  return (
    <div className="course-picker">
      <div className="segmented" aria-label={t('学校')}>
        {SCHOOLS.map(([school, label]) => {
          const first = listed.find((c) => c.school === school)
          return (
            <button key={school} disabled={disabled || !first} aria-pressed={current.school === school} onClick={() => first && onChange(first.id)}>
              {label}
            </button>
          )
        })}
      </div>
      <select value={current.id} disabled={disabled} aria-label={t('科目')} onChange={(e) => onChange(e.target.value)}>
        {subjects.map((subject) => (
          <optgroup key={subject} label={subject}>
            {inSchool
              .filter((c) => c.subjectLabel === subject)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                  {c.hasCurriculum ? `（${c.ready} / ${c.total}）` : t('（準備中）')}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </div>
  )
}
