import { isLang, setLang } from '@shared/i18n'
import { getSettings } from './store'

// 表示する言語を、ほかのモジュールが文言を決める前に設定する（index.ts のいちばん初めに読みこむ）
const saved = getSettings().language
setLang(isLang(saved) ? saved : 'ja')
