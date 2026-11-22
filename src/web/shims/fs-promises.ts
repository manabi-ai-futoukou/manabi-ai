/** Node の fs/promises の代わり（Web 版）。中身は fs.ts にある。 */
import { promises } from './fs'

export const { writeFile, readFile, rename, unlink, copyFile, stat, mkdir, rm } = promises
export default promises
