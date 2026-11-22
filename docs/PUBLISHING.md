# 公開の手順

学びアイを公開するときの手順です。公開するものは 2 つです。

| もの | 置き場 | 作り方 |
| --- | --- | --- |
| Web 版 | Cloudflare（Workers の静的なファイルの配信） | `npm run release:prepare` → `npx wrangler deploy` |
| Windows 版（インストーラー）とソース | GitHub（`manabi-ai-futoukou/manabi-ai`） | `npm run build` → `npm run dist` → Releases に置く |

サインイン・契約・支払い・鍵の入力は、かならず本人が行います。

## 0. 公開の前に確かめること

- [ ] `npm run typecheck` と `npm run smoke` が通る
- [ ] `npm run release:prepare` の終わりに「問題は見つかりませんでした。」と出る（ファイルの数、1 個の大きさ、大学・大学院の教材が入っていないこと、単元表にある授業の本文がそろっていること、取りこんでいない教材が無いこと、この PC の名前入りの道すじが無いことを見ています）
- [ ] `THIRD_PARTY_NOTICES.md` が新しい（`release:prepare` が作り直します）
- [ ] README の「教材についての注意」（検定を受けた教科書ではない・専門教科は専門家の確認なし）が入っている
- [ ] Web 版を手もとで開いて、教科書・ノート・「AI のつなぎ方」（自分の API キーだけが出る）を見た

## 1. 配るものを用意する

**先に「教材を取りこむ」を済ませてください**（Claude の中で作った教材を、本当のデータ置き場へ写す）。取りこんでいない教材があると、古い教材が書き出されてしまうので、次の道具は途中で止まります。

```powershell
npm run release:prepare
```

`release/site/dist/` に、Web 版と、公開する科目（小学校・中学校・高校・高校の専門教科）の教材が書き出されます。教材は、この PC のデータ置き場（`%APPDATA%\学びアイ\data\`）から集めます。

手もとで見るとき:

```powershell
npx serve release/site/dist
```

## 2. Web 版を Cloudflare に置く

### なぜ Cloudflare の有料プランか

Web 版は、サーバーのプログラムが要らない「ファイルを置くだけのサイト」です（AI は、利用者が自分の API キーで、ブラウザーから直接つなぎます）。ただし、教材のファイルが多いので（数万個）、置き場の「ファイルの数の上限」が決め手になります。

| | 無料 | Workers Paid（月 5 ドル） |
| --- | --- | --- |
| 1 つのサイトに置けるファイル | 20,000 個 | 100,000 個 |
| 1 個の大きさ | 25 MiB まで | 25 MiB まで |
| 静的なファイルの配信の料金 | 無料 | 無料（転送量でも増えません） |

（2026 年 11 月に、Cloudflare の公式の資料で確かめた数です。変わることがあるので、契約の前に公式のページを見てください。）

### 手順

1. **アカウントを作る**: <https://dash.cloudflare.com/sign-up> で、Cloudflare のアカウントを作ります。
2. **有料プランにする**: ダッシュボードの「Workers & Pages」→「Plans」で、**Workers Paid**（月 5 ドル）を選び、支払いの方法を入れます。
3. **この PC から Cloudflare につなぐ**（はじめの 1 回だけ。ブラウザーが開くので、許可します）:

   ```powershell
   npx wrangler login
   ```

4. **置く**（`app` のフォルダーで。設定は `wrangler.jsonc`）:

   ```powershell
   npx wrangler deploy
   ```

   はじめてのときは、数万個のファイルを送るので、時間がかかります。2 回めからは、変わったファイルだけを送ります。
   終わると、`https://manabi-ai.<アカウントの名前>.workers.dev` のような URL が出ます。これが Web 版の住所です。
5. **開いて確かめる**: その URL を、PC・iPad・Chromebook で開き、教科書とノートを見ます。

### 自分のドメインを使うとき（しなくてもよい）

ダッシュボードの「Workers & Pages」→ `manabi-ai` →「Settings」→「Domains & Routes」→「Add」→「Custom Domain」で、Cloudflare に置いたドメインを選びます。ドメインそのものは、Cloudflare Registrar などで、別に買います（年に 10〜15 ドルくらい）。

### 教材やプログラムを新しくしたとき

```powershell
npm run release:prepare
npx wrangler deploy
```

### 前の版にもどすとき

```powershell
npx wrangler rollback
```

### ほかの置き場とのちがい

- **GitHub Pages**（無料）: サイト全体で 1 GB まで、月の転送量 100 GB が目安。教材をふくめると上限に近く、公開のたびの作り直しにも時間がかかるので、すすめません。
- **Cloudflare Pages**: Workers の静的なファイルの配信と、上限はほぼ同じです。Cloudflare は、新しく作るものには Workers のほうをすすめているので、こちらにしています。
- **Cloudflare R2**（ファイル置き場。10 GB まで無料・転送料なし）: 動画のように 25 MiB をこえるファイルを配りたくなったら、足します。いまは使っていません。

将来、Web 版でも Sign in with ChatGPT を使うときは、サインインを受けるサーバーのプログラム（Worker）と、OpenAI への申し込みが要ります。そのときも、同じ Cloudflare の契約の中で足せます。

## 3. GitHub に出す

### はじめの 1 回

1. GitHub に `manabi-ai-futoukou` でサインインし、**公開（Public）**のリポジトリ `manabi-ai` を作ります（README やライセンスは、足さずに空のまま）。
2. メールアドレスを出さないために、GitHub の「Settings」→「Emails」で「Keep my email addresses private」を入れ、そこに出る `…@users.noreply.github.com` を控えます。
3. `app` のフォルダーで:

   ```powershell
   git init -b main
   git config user.name "manabi-ai-futoukou"
   git config user.email "<控えた noreply のアドレス>"
   git add .
   git status
   ```

   `git status` で、出すファイルを見ます。`.gitignore` で、作ったもの（`out/`・`dist-web/`・`release/`）、動作確認の写真、ためした道具（`.try/`）、もとの絵（`assets-src/`）は、外してあります。

   ```powershell
   git commit -m "はじめの公開"
   git remote add origin https://github.com/manabi-ai-futoukou/manabi-ai.git
   git push -u origin main
   ```

### Windows 版を出す

```powershell
npm run release:prepare
npm run build
npm run dist
```

`release/win/ManabiAI-Setup-<版>.exe` ができます。GitHub のリポジトリの「Releases」→「Draft a new release」で、版の名前（例: `v0.1.0`）をつけて、このファイルを置きます。

- 教材は、インストーラーの中に入っています（はじめて開いたときに、利用者のデータの置き場へ写します）。
- インストーラーには、署名をつけていません。Windows が「不明な発行元」と知らせます。署名をつけるには、コード署名の証明書（有料）が要ります。
- 版を上げるときは、`package.json` の `version` を変えます。

### 教材そのものを配るとき

教材（授業の文章など）は、リポジトリには入れていません（数万個・数百 MB あるため）。インストーラーと Web 版に入っているほか、`release/site/dist/data/` を zip にして、Releases に置くこともできます。
