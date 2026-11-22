# 学びアイ（Manabi AI）

「流動する教科書」をテーマにした、小学校から高校までの総合学習アプリです。
教科書を読み、わからないところを AI の先生や同級生にたずね、ノートに書き、テストや特訓で確かめる、までを 1 つのアプリで行えます。

- **Windows 版**（インストーラー）と、**Web 版**（ブラウザーで開く。iPad・Chromebook でも使えます）の 2 つがあります。
- プログラムも教材も、オープンソース（MIT ライセンス）です。くわしくは「ライセンス」を見てください。

> [!IMPORTANT]
> 教材は、AI（Claude・GPT）で作り、AI どうしで検査したものです。学習指導要領に沿って組み立てていますが、**検定を受けた教科書ではなく、誤りがふくまれていることがあります**。
> とくに**高校の専門教科（農業・工業・商業・水産・家庭・看護・情報・福祉など）は、専門家の確認を受けていません**。実習・安全・資格・法令に関わる内容は、かならず正式な教科書や指導者のもとで確かめてください。

## できること

| モード | できること |
| --- | --- |
| 教科書 | 授業を読む。用語にふりがなと説明が出る。文を選んで、そのまま質問へ進める。授業を開くと、その授業のノートが利き手の側に開く |
| チャット | 授業の内容を、先生や同級生（先生 1 人と、同級生 20 人）に質問する |
| ノート | 手書き（筆圧つき）とタイピング。罫線、図形、表、座標平面、画像。指のジェスチャー（2 本指で軽くたたく = 元に戻す、3 本指 = やり直す、置いたままにすると、くり返す。2 本指で動かす・開く・閉じる = 移動と拡大・縮小） |
| ノートの評価 | 先生がノートを読み、理解力・応用力・発想力を見る |
| 記述・論述 | 授業ごとの記述と論述の問題に答え、先生に見てもらう |
| テスト・成績 | AI が作った問題を解く。週ごとの 5 つの観点と、特訓で育つ力を見る |
| ディベート | 論題について同級生と肯定側・否定側に分かれて話し合い、ジャッジが判定する |
| 英会話 | 言いたいことを英語にして、声に出して伝える |
| 語彙力特訓・漢字特訓 | 言葉と漢字を、書いて覚える（漢字は、書き順のアニメーションつき） |

収録している教材: 小学校 37 科目・中学校 22 科目・高校 55 科目・高校の専門教科 229 科目（合わせて 343 科目）。大学・大学院は準備中で、いまは出していません。

## つかう

### Windows 版

1. [Releases](https://github.com/manabi-ai-futoukou/manabi-ai/releases) から `ManabiAI-Setup-x.y.z.exe` を取り寄せて、入れます。
2. はじめて開くときに、教材をこの PC の中に用意します（1〜2 分かかります）。
3. 「設定」→「AI のつなぎ方」で、AI のつなぎ方を選びます（下の「AI について」）。

インストーラーには署名をつけていないので、Windows が「不明な発行元」と知らせることがあります。

### Web 版

<https://manabi-ai.gakushu.app/> を、ブラウザーで開くだけで使えます。ノートや成績は、その端末のブラウザーの中に保存されます（ほかの端末には写りません）。
ホーム画面に追加すると、アプリのように開けます。

## AI について

学びアイは、AI を自分では持っていません。**利用者が、自分で契約した AI をつないで使います。** つながなくても、教科書を読む・ノートを書く・漢字や言葉の練習は使えます。

| つなぎ方 | Windows 版 | Web 版 | 内容 |
| --- | --- | --- | --- |
| Sign in with ChatGPT | ○ | 準備中 | 自分の ChatGPT のプラン（Plus・Pro）の枠を使います。OpenAI の決まりで、13 歳以上の人が使えます |
| 自分の API キー | ○ | ○ | Claude（Anthropic）か OpenAI の API キーを、自分で契約して入れます。使ったぶんの料金は、キーの持ち主にかかります |

- API キーとサインインの情報は、その端末の中だけに置きます（Windows 版は、Windows の仕組みで暗号化します）。学びアイの作者や、ほかのサーバーには送りません。
- AI にたずねた内容（質問、評価をたのんだノートの画像など）は、選んだ AI の会社（OpenAI または Anthropic）に送られます。それぞれの会社の利用規約と、年齢の決まりに従ってください。
- 子どもが使うときは、保護者の方が、AI の契約と使い方を確かめてください。

## プライバシー

ノート・会話・成績・設定は、利用者の端末の中だけに保存します（Windows 版は `%APPDATA%\学びアイ\data\`、Web 版はブラウザーの中）。
学びアイは、利用の記録を集めたり、外へ送ったりしません。外へ出る通信は、上に書いた AI への問い合わせと、英会話の音声認識の部品を取り寄せるとき（Windows 版。はじめて使うときだけ）です。

## 自分で作る（開発する人へ）

Node.js 22 以上が要ります。

```powershell
npm ci
npm run dev          # 開発用に開く
npm run typecheck    # 型の検査
npm run build        # Windows 版を作る（out/）
npm run smoke        # 動作確認のテスト
npm run web:build    # Web 版を作る（dist-web/）
npm run web          # Web 版を、この PC で開く（http://127.0.0.1:5273/）
```

配るものを作るとき（教材は、リポジトリの外のデータ置き場から集めます）:

```powershell
npm run release:prepare   # Web 版と教材を release/site/dist/ に書き出し、表示の文書を作って、確かめる
npm run build
npm run dist              # インストーラーを release/win/ に作る
```

開発中（`npm run dev` など）は、配る版には無いものも出ます: 教材づくり（単元表と授業を、AI にまとめて作らせる画面）、教科書の「掛け合い」「動く図解」を AI に作り直させるボタン、この PC の claude・codex のコマンドで AI を動かす方式。

- しくみと、これまでの開発の記録: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- Web 版を公開する手順（Cloudflare）: [docs/PUBLISHING.md](docs/PUBLISHING.md)

## ライセンス

- **自分たちで作ったもの**（プログラム、授業の文章、用語集、記述・論述の問題、AI で作った挿絵と人物の絵）は、[MIT ライセンス](LICENSE)です。
- **それ以外のもの**（漢字のデータ = CC BY-SA、授業の資料の画像 = パブリックドメイン・CC0・CC BY、組みこんだ部品など）は、**元のライセンスのまま**です。出どころと条件は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にまとめています。

## English summary

Manabi AI is an open-source study app for Japanese elementary, junior high and high school subjects (343 courses): a textbook reader, an AI teacher and classmates to ask, a handwriting notebook, tests, debates, English conversation, and kanji and vocabulary drills. It ships as a Windows app and as a web app (PWA).

The app does not include an AI service. Users connect their own: **Sign in with ChatGPT** (Windows app; ages 13+) or **their own API key** for Claude or OpenAI (Windows and web). Keys and notes stay on the user's device.

The learning materials were written and cross-checked by AI. They follow the Japanese national curriculum but are **not officially approved textbooks and may contain errors**; the vocational high-school subjects have **not been reviewed by subject experts**.

Our own code, texts and AI-generated illustrations are MIT-licensed. Third-party materials (kanji data under CC BY-SA, reference images in the public domain or under CC0 / CC BY, and bundled libraries) keep their original licenses — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
