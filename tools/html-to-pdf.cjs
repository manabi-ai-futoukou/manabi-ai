// HTML のファイルを、A4 の PDF にする（申請に添える企画書などを作るための道具）。
//
//   node_modules\electron\dist\electron.exe tools\html-to-pdf.cjs <入力.html> <出力.pdf> [確認用の画像.png]
//
// 画面には何も出さずに終わる。確認用の画像を指定すると、1 ページ目のあたりを画像にして書き出す。
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { resolve } = require('node:path')

const [input, output, preview] = process.argv.slice(2)
if (!input || !output) {
  console.error('入力の HTML と、出力の PDF を指定してください。')
  process.exit(2)
}

app.disableHardwareAcceleration()
void app.whenReady().then(async () => {
  // A4（210mm × 297mm）を 96dpi で表した大きさ
  const window = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { offscreen: true } })
  await window.loadFile(resolve(input))
  await new Promise((done) => setTimeout(done, 800))
  const pdf = await window.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true })
  writeFileSync(resolve(output), pdf)
  if (preview) writeFileSync(resolve(preview), (await window.webContents.capturePage()).toPNG())
  console.log(`${output}: ${Math.round(pdf.length / 1024)} KB`)
  app.quit()
})
