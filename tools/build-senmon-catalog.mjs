// 高校の専門教科（主として専門学科において開設される各教科・科目）を、科目表（catalog.json）に足す。
//
//   node tools/build-senmon-catalog.mjs           原典と照らして、足す内容を表示するだけ
//   node tools/build-senmon-catalog.mjs --write   科目表に書きこむ（すでにある専門教科の行は、作り直す）
//
// 科目の名前と「扱う内容」は、高等学校学習指導要領（平成 30 年告示）の本文から取る。
// 本文は、国立教育政策研究所の「学習指導要領データベース」から読む（https://erid.nier.go.jp/）。
// 下の表にある科目の名前や数が、本文と 1 つでも食いちがえば、書きこまずに止まる（これが原典との照合になる）。
//
// 13 教科（農業・工業・商業・水産・家庭・看護・情報・福祉・理数・体育・音楽・美術・英語）229 科目を、原典の順に並べている。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const BASE = 'https://erid.nier.go.jp/files/COFS/h30h/'
const catalogFile = join(resolve(import.meta.dirname, '..'), 'resources', 'content', 'catalog.json')
const SCHOOL = 'hsp'
const SCHOOL_LABEL = '高校（専門）'

// [科目の名前（原典のとおり）, ID の後ろの部分, 授業数の目安, 追加の指定]
//   practice: 学校では実習や課題研究として行う科目（アプリでは、進め方・記録・安全だけを扱う）
//   guide:    書き方の指示を、教科のものから変えるとき（authoring.ts の SUBJECT_GUIDES の名前。+ でつなげる）
//   scope:    本文の指導項目が「扱う内容」として使いにくいとき、こちらを使う
const SUBJECTS = [
  {
    chapter: 'chap3-1',
    subject: 'agriculture',
    label: '農業',
    slug: 'nogyo',
    guide: 'agriculture',
    courses: [
      ['農業と環境', 'kankyo', 34],
      ['課題研究', 'kadai', 14, { practice: true }],
      ['総合実習', 'sogo-jisshu', 14, { practice: true }],
      ['農業と情報', 'joho', 24, { guide: 'agriculture+information' }],
      ['作物', 'sakumotsu', 32],
      ['野菜', 'yasai', 32],
      ['果樹', 'kaju', 30],
      ['草花', 'kusabana', 30],
      ['畜産', 'chikusan', 32],
      ['栽培と環境', 'saibai-kankyo', 26],
      ['飼育と環境', 'shiiku-kankyo', 24],
      ['農業経営', 'keiei', 32, { guide: 'agriculture+commerce' }],
      ['農業機械', 'kikai', 26],
      ['植物バイオテクノロジー', 'biotech', 28],
      ['食品製造', 'shokuhin-seizo', 32, { guide: 'agriculture+food' }],
      ['食品化学', 'shokuhin-kagaku', 28, { guide: 'agriculture+food' }],
      ['食品微生物', 'shokuhin-biseibutsu', 28, { guide: 'agriculture+food' }],
      ['食品流通', 'shokuhin-ryutsu', 26, { guide: 'agriculture+food' }],
      ['森林科学', 'shinrin-kagaku', 30],
      ['森林経営', 'shinrin-keiei', 28],
      ['林産物利用', 'rinsanbutsu', 28],
      ['農業土木設計', 'doboku-sekkei', 30],
      ['農業土木施工', 'doboku-seko', 28],
      ['水循環', 'mizu-junkan', 26],
      ['造園計画', 'zoen-keikaku', 28],
      ['造園施工管理', 'zoen-seko', 28],
      ['造園植栽', 'zoen-shokusai', 26],
      ['測量', 'sokuryo', 28],
      ['生物活用', 'seibutsu-katsuyo', 26],
      ['地域資源活用', 'chiiki-shigen', 26],
    ],
  },
  {
    chapter: 'chap3-2',
    subject: 'industry',
    label: '工業',
    slug: 'kogyo',
    guide: 'industry',
    courses: [
      ['工業技術基礎', 'gijutsu-kiso', 24],
      ['課題研究', 'kadai', 14, { practice: true }],
      ['実習', 'jisshu', 14, { practice: true }],
      ['製図', 'seizu', 26],
      ['工業情報数理', 'joho-suri', 30, { guide: 'industry+information' }],
      ['工業材料技術', 'zairyo-gijutsu', 26],
      ['工業技術英語', 'eigo', 22, { guide: 'industry+english' }],
      ['工業管理技術', 'kanri-gijutsu', 24],
      ['工業環境技術', 'kankyo-gijutsu', 24],
      ['機械工作', 'kikai-kosaku', 30],
      ['機械設計', 'kikai-sekkei', 34],
      ['原動機', 'gendoki', 30],
      ['電子機械', 'denshi-kikai', 30],
      ['生産技術', 'seisan-gijutsu', 28],
      ['自動車工学', 'jidosha-kogaku', 30],
      ['自動車整備', 'jidosha-seibi', 24],
      ['船舶工学', 'senpaku-kogaku', 26],
      ['電気回路', 'denki-kairo', 40],
      ['電気機器', 'denki-kiki', 28],
      ['電力技術', 'denryoku', 32],
      ['電子技術', 'denshi-gijutsu', 28],
      ['電子回路', 'denshi-kairo', 30],
      ['電子計測制御', 'keisoku-seigyo', 28],
      ['通信技術', 'tsushin', 28],
      ['プログラミング技術', 'programming', 30, { guide: 'industry+information' }],
      ['ハードウェア技術', 'hardware', 30, { guide: 'industry+information' }],
      ['ソフトウェア技術', 'software', 28, { guide: 'industry+information+infopro' }],
      ['コンピュータシステム技術', 'computer-system', 28, { guide: 'industry+information+infopro' }],
      ['建築構造', 'kenchiku-kozo', 30],
      ['建築計画', 'kenchiku-keikaku', 32],
      ['建築構造設計', 'kenchiku-kozo-sekkei', 34],
      ['建築施工', 'kenchiku-seko', 28],
      ['建築法規', 'kenchiku-hoki', 24],
      ['設備計画', 'setsubi-keikaku', 26],
      ['空気調和設備', 'kuki-chowa', 28],
      ['衛生・防災設備', 'eisei-bosai', 28],
      ['測量', 'sokuryo', 30],
      ['土木基盤力学', 'doboku-rikigaku', 32],
      ['土木構造設計', 'doboku-kozo-sekkei', 32],
      ['土木施工', 'doboku-seko', 28],
      ['社会基盤工学', 'shakai-kiban', 26],
      ['工業化学', 'kogyo-kagaku', 40],
      ['化学工学', 'kagaku-kogaku', 28],
      ['地球環境化学', 'chikyu-kankyo-kagaku', 26],
      ['材料製造技術', 'zairyo-seizo', 26],
      ['材料工学', 'zairyo-kogaku', 28],
      ['材料加工', 'zairyo-kako', 26],
      ['セラミック化学', 'ceramic-kagaku', 26],
      ['セラミック技術', 'ceramic-gijutsu', 24],
      ['セラミック工業', 'ceramic-kogyo', 24],
      ['繊維製品', 'seni-seihin', 22],
      ['繊維・染色技術', 'seni-senshoku', 24],
      ['染織デザイン', 'senshoku-design', 22],
      ['インテリア計画', 'interior-keikaku', 28],
      ['インテリア装備', 'interior-sobi', 24],
      ['インテリアエレメント生産', 'interior-element', 22],
      ['デザイン実践', 'design-jissen', 26],
      ['デザイン材料', 'design-zairyo', 22],
      ['デザイン史', 'design-shi', 22],
    ],
  },
  {
    chapter: 'chap3-3',
    subject: 'commerce',
    label: '商業',
    slug: 'shogyo',
    guide: 'commerce',
    courses: [
      ['ビジネス基礎', 'business-kiso', 36],
      ['課題研究', 'kadai', 14, { practice: true }],
      ['総合実践', 'sogo-jissen', 14, { practice: true }],
      ['ビジネス・コミュニケーション', 'communication', 30],
      ['マーケティング', 'marketing', 34],
      ['商品開発と流通', 'shohin', 30],
      ['観光ビジネス', 'kanko', 28],
      ['ビジネス・マネジメント', 'management', 32],
      ['グローバル経済', 'global', 30],
      ['ビジネス法規', 'hoki', 34],
      ['簿記', 'boki', 44],
      ['財務会計Ⅰ', 'zaimu1', 36],
      ['財務会計Ⅱ', 'zaimu2', 34],
      ['原価計算', 'genka', 36],
      ['管理会計', 'kanri-kaikei', 30],
      ['情報処理', 'joho-shori', 32, { guide: 'commerce+information' }],
      ['ソフトウェア活用', 'software', 28, { guide: 'commerce+information' }],
      ['プログラミング', 'programming', 32, { guide: 'commerce+information' }],
      ['ネットワーク活用', 'net-katsuyo', 26, { guide: 'commerce+information+infopro' }],
      ['ネットワーク管理', 'net-kanri', 26, { guide: 'commerce+information+infopro' }],
    ],
  },
  {
    chapter: 'chap3-4',
    subject: 'fishery',
    label: '水産',
    slug: 'suisan',
    guide: 'fishery',
    courses: [
      ['水産海洋基礎', 'kiso', 28],
      ['課題研究', 'kadai', 14, { practice: true }],
      ['総合実習', 'sogo-jisshu', 14, { practice: true }],
      ['海洋情報技術', 'joho', 26, { guide: 'fishery+information' }],
      ['水産海洋科学', 'kagaku', 30],
      ['漁業', 'gyogyo', 30],
      ['航海・計器', 'kokai', 30],
      ['船舶運用', 'senpaku-unyo', 30],
      ['船用機関', 'kikan', 30, { guide: 'fishery+industry' }],
      ['機械設計工作', 'kikai-sekkei', 26, { guide: 'fishery+industry' }],
      ['電気理論', 'denki-riron', 30, { guide: 'fishery+industry' }],
      ['移動体通信工学', 'idotai-tsushin', 28, { guide: 'fishery+industry' }],
      ['海洋通信技術', 'kaiyo-tsushin', 24, { guide: 'fishery+industry' }],
      ['資源増殖', 'zoshoku', 30],
      ['海洋生物', 'seibutsu', 28],
      ['海洋環境', 'kankyo', 26],
      ['小型船舶', 'kogata-senpaku', 24],
      ['食品製造', 'shokuhin-seizo', 28, { guide: 'fishery+food' }],
      ['食品管理', 'shokuhin-kanri', 28, { guide: 'fishery+food' }],
      ['水産流通', 'ryutsu', 24],
      ['ダイビング', 'diving', 22],
      ['マリンスポーツ', 'marine-sports', 20],
    ],
  },
  {
    chapter: 'chap3-5',
    subject: 'home',
    label: '家庭',
    slug: 'katei',
    guide: 'home+homepro',
    courses: [
      ['生活産業基礎', 'sangyo-kiso', 24],
      ['課題研究', 'kadai', 14, { practice: true }],
      ['生活産業情報', 'sangyo-joho', 24, { guide: 'home+homepro+information' }],
      ['消費生活', 'shohi', 30],
      ['保育基礎', 'hoiku-kiso', 32],
      ['保育実践', 'hoiku-jissen', 20],
      ['生活と福祉', 'fukushi', 28, { guide: 'home+homepro+welfare' }],
      ['住生活デザイン', 'jusei', 28],
      ['服飾文化', 'fukushoku', 22],
      ['ファッション造形基礎', 'zokei-kiso', 26],
      ['ファッション造形', 'zokei', 22],
      ['ファッションデザイン', 'fashion-design', 24],
      ['服飾手芸', 'shugei', 18],
      ['フードデザイン', 'food-design', 30],
      ['食文化', 'shokubunka', 24],
      ['調理', 'chori', 28],
      ['栄養', 'eiyo', 32],
      ['食品', 'shokuhin', 30],
      ['食品衛生', 'shokuhin-eisei', 30],
      ['公衆衛生', 'koshu-eisei', 30],
      ['総合調理実習', 'chori-jisshu', 14, { practice: true }],
    ],
  },
  {
    chapter: 'chap3-6',
    subject: 'nursing',
    label: '看護',
    slug: 'kango',
    guide: 'nursing',
    courses: [
      ['基礎看護', 'kiso', 40],
      ['人体の構造と機能', 'jintai', 44],
      ['疾病の成り立ちと回復の促進', 'shippei', 44],
      ['健康支援と社会保障制度', 'shakai-hosho', 30],
      ['成人看護', 'seijin', 40],
      ['老年看護', 'ronen', 30],
      ['小児看護', 'shoni', 28],
      ['母性看護', 'bosei', 28],
      ['精神看護', 'seishin', 30],
      ['在宅看護', 'zaitaku', 26],
      ['看護の統合と実践', 'togo', 24],
      ['看護臨地実習', 'rinchi-jisshu', 14, { practice: true }],
      ['看護情報', 'joho', 22, { guide: 'nursing+information' }],
    ],
  },
  {
    chapter: 'chap3-7',
    subject: 'information',
    label: '情報',
    slug: 'joho',
    guide: 'information+infopro',
    courses: [
      ['情報産業と社会', 'sangyo', 30],
      ['課題研究', 'kadai', 14, { practice: true }],
      ['情報の表現と管理', 'hyogen', 26],
      ['情報テクノロジー', 'technology', 30],
      ['情報セキュリティ', 'security', 28],
      ['情報システムのプログラミング', 'programming', 34],
      ['ネットワークシステム', 'network', 32],
      ['データベース', 'database', 30],
      ['情報デザイン', 'design', 28],
      ['コンテンツの制作と発信', 'contents', 28],
      ['メディアとサービス', 'media', 22],
      ['情報実習', 'jisshu', 16, { practice: true }],
    ],
  },
  {
    chapter: 'chap3-8',
    subject: 'welfare',
    label: '福祉',
    slug: 'fukushi',
    guide: 'welfare',
    courses: [
      ['社会福祉基礎', 'kiso', 36],
      ['介護福祉基礎', 'kaigo-kiso', 32],
      ['コミュニケーション技術', 'communication', 22],
      ['生活支援技術', 'seikatsu-shien', 36],
      ['介護過程', 'kaigo-katei', 24],
      ['介護総合演習', 'enshu', 14, { practice: true }],
      ['介護実習', 'jisshu', 14, { practice: true }],
      ['こころとからだの理解', 'kokoro-karada', 40],
      ['福祉情報', 'joho', 22, { guide: 'welfare+information' }],
    ],
  },
  {
    chapter: 'chap3-9',
    subject: 'risu',
    label: '理数',
    slug: 'risu',
    guide: 'science',
    // 理数科の科目は、共通の数学・理科の科目と内容が重なる。ちがいが単元表に出るよう、扱い方を書き添える
    scopeNote: '。理数科の科目として、共通の数学・理科の科目で学ぶ内容を、定義・証明・導出や探究の過程をふくめて、発展的に扱う',
    courses: [
      ['理数数学Ⅰ', 'sugaku1', 40, { guide: 'math' }],
      ['理数数学Ⅱ', 'sugaku2', 50, { guide: 'math' }],
      ['理数数学特論', 'sugaku-tokuron', 28, { guide: 'math' }],
      ['理数物理', 'butsuri', 44],
      ['理数化学', 'kagaku', 44],
      ['理数生物', 'seibutsu', 44],
      ['理数地学', 'chigaku', 40],
    ],
  },
  // 体育・音楽・美術は、実技（運動・演奏・制作）が中心の教科。指導項目も「独唱」「デッサン」のように短い。
  // このアプリでは実技そのものは行えないので、指導項目と「内容の取扱い」にもとづいて、読んで学べる内容を書き起こす
  {
    chapter: 'chap3-10',
    subject: 'pe',
    label: '体育',
    slug: 'taiiku',
    guide: 'pe+pepro',
    courses: [
      ['スポーツ概論', 'gairon', 30, { scope: 'スポーツの文化的特性や現代におけるスポーツの発展（スポーツの歴史と文化、国際的な大会、経済やメディアとの関わり、スポーツの倫理とドーピングの防止）、スポーツの効果的な学習の仕方（技術と戦術、技能が上達する過程、練習の計画、体力トレーニングの原則、心の準備）、豊かなスポーツライフの設計の仕方（ライフステージとスポーツ、する・みる・支える・知るという関わり方、スポーツを進める施策と環境）、スポーツの多様な指導法と健康・安全（発達の段階に応じた指導、暴力やハラスメントのない指導、けがや熱中症の予防、救急の考え方）、スポーツの企画と運営（大会やイベントの企画、組織、広報、安全管理、ふり返り）' }],
      ['スポーツⅠ', 'sports1', 22, { scope: '採点競技（体操競技）と測定競技（陸上競技、水泳競技。地域によってスキー、スケートなど）への多様な関わり方。このアプリでは実技は行えないので、競技の成り立ちと特性、種目とルール、採点や計測のしくみ、技や動きの原理（力学と体の使い方）、練習の段階と計画、けがの予防と安全、審判・記録・運営・指導・観戦といった関わり方を扱う' }],
      ['スポーツⅡ', 'sports2', 26, { scope: '球技への多様な関わり方。ゴール型（バスケットボール、ハンドボール、サッカー、ラグビー）、ネット型（バレーボール、卓球、テニス、バドミントン）、ベースボール型（ソフトボール、野球）、ターゲット型（ゴルフ）。このアプリでは実技は行えないので、型ごとの特性、ルールと審判法、個人の技術とチームの戦術の考え方、ゲームの分析、練習の計画、けがの予防と安全、審判・記録・運営・指導・観戦といった関わり方を扱う' }],
      ['スポーツⅢ', 'sports3', 22, { scope: '武道（柔道、剣道、相撲、空手道、なぎなた、弓道、合気道、少林寺拳法、銃剣道）と、諸外国の対人的競技（レスリング）への多様な関わり方。このアプリでは実技は行えないので、武道の成り立ちと伝統的な考え方、礼法、種目ごとの特性とルール、技の原理（崩し、間合い、体さばきなど）、練習の段階、頭や首のけがを防ぐ安全の考え方、審判・運営・指導・観戦といった関わり方を扱う' }],
      ['スポーツⅣ', 'sports4', 20, { scope: 'ダンスへの多様な関わり方。創造型ダンス（創作ダンス、現代的なリズムのダンス）と伝承型ダンス（フォークダンス、社交ダンス）。このアプリでは実技は行えないので、ダンスの歴史と文化、種類ごとの特性、動き・リズム・空間・構成の考え方、作品づくりと発表の進め方、鑑賞と批評、けがの予防、発表会の企画・運営や指導といった関わり方を扱う' }],
      ['スポーツⅤ', 'sports5', 22, { scope: '野外の運動への多様な関わり方。自然体験型（キャンプ、登山、遠泳などの水辺活動）と競技型（スキー、スケート）。このアプリでは実技は行えないので、野外活動の意義と特性、自然環境と気象の理解、計画の立て方、装備、活動ごとの基本の考え方、遭難・溺水・低体温・熱中症などの危険と防ぎ方、自然環境の保全、指導・運営といった関わり方を扱う' }],
      ['スポーツⅥ', 'sports6', 22, { scope: '体つくり運動への多様な関わり方、目的に応じた心身の気付きや交流を深めるための運動の仕方、ライフステージ及びライフスタイルに応じた体操や運動の計画の立て方。体の構造と体力の要素、トレーニングの原則と方法、体ほぐしの運動の考え方、年齢・目的・生活に応じた運動の計画、運動と栄養・休養、無理な運動による障害の予防、指導や支援といった関わり方を扱う' }],
      ['スポーツ総合演習', 'enshu', 14, { practice: true, scope: 'スポーツの多様な理論や実践に関する課題研究、スポーツの多様な指導や企画と運営に関する課題研究、スポーツを通した多様な社会参画に関する課題研究。学校では課題研究として行う科目。このアプリでは、課題の見つけ方、調べ方と計画の立て方、データの集め方と分析、まとめ方と発表、研究の倫理を扱う' }],
    ],
  },
  {
    chapter: 'chap3-11',
    subject: 'music',
    label: '音楽',
    slug: 'ongaku',
    guide: 'music+musicpro',
    courses: [
      ['音楽理論', 'riron', 40, { scope: '楽典（音名と階名、譜表、音符と休符、拍子とリズム、音程、音階と調、移調と転調、和音、楽語と記号）、楽曲の形式（動機と楽節、二部形式・三部形式、ロンド形式、変奏曲、ソナタ形式、フーガなど）、和声法（三和音と七の和音、和音の機能、連結の規則、終止、転回形、非和声音、借用和音と転調）、対位法（旋律の独立性、二声の対位法の基本、模倣とカノン）。必要に応じて、我が国の伝統音楽の理論（音階、拍節、形式）にも触れる' }],
      ['音楽史', 'shi', 34, { scope: '我が国の音楽史（古代の音楽と雅楽、声明、能楽、箏曲・三味線音楽・尺八音楽、近世の劇場音楽、明治以降の洋楽の受容、現代の音楽）と、諸外国の音楽史（西洋音楽史を中心に、古代・中世、ルネサンス、バロック、古典派、ロマン派、近代・現代。その他の地域の音楽の歴史にも触れる）。時代ごとの社会や文化との関わり、様式の特徴、主な作曲家と作品を扱い、両者を関連付ける' }],
      ['演奏研究', 'enso-kenkyu', 22, { scope: '時代や地域による表現上の特徴を踏まえた解釈及び演奏に関する研究、作曲家の表現上の特徴を踏まえた解釈及び演奏に関する研究、声や楽器の特徴を踏まえた解釈及び演奏に関する研究、音楽の解釈の多様性。このアプリでは演奏そのものは行えないので、楽譜の読み取り方、時代様式と演奏習慣（装飾、テンポ、アーティキュレーション、強弱）、作曲家ごとの語法、版によるちがい、同じ曲の演奏を聴き比べる視点、解釈を言葉で説明する方法を扱う' }],
      ['ソルフェージュ', 'solfege', 22, { scope: '視唱、視奏、聴音。このアプリでは音を出して確かめることはできないので、読譜の力の土台になる知識（音部記号、音程の聴き取り方と歌い方の手がかり、リズムの読み方と数え方、拍子、調と階名、和音の聴き分け）、視唱・視奏・聴音の練習の進め方、楽譜に書き取るときの進め方とよくあるつまずきを扱う' }],
      ['声楽', 'seigaku', 22, { scope: '独唱、様々な形態のアンサンブル。このアプリでは歌う指導はできないので、声の出るしくみ（呼吸、発声、共鳴）、声種と声域、姿勢と呼吸の考え方、言葉の発音（日本語、イタリア語、ドイツ語などの歌唱発音の基本）、歌曲・オペラ・合唱などのジャンルと代表的な作品、楽曲の解釈、重唱や合唱での合わせ方、声の健康を守る練習のしかたを扱う。必要に応じて、我が国の伝統的な歌唱にも触れる' }],
      ['器楽', 'kigaku', 26, { scope: '鍵盤楽器・弦楽器・管楽器・打楽器・和楽器の独奏、様々な形態のアンサンブル。このアプリでは演奏の指導はできないので、楽器の分類と発音のしくみ、それぞれの楽器の構造・音域・音色、奏法の基本の考え方、代表的な作品、練習の計画と体を痛めない練習のしかた、室内楽・吹奏楽・オーケストラなどの編成と合わせ方、楽器の手入れを扱う' }],
      ['作曲', 'sakkyoku', 24, { scope: '様々な表現形態の楽曲の創作。動機と旋律の作り方、旋律への和音づけ、形式の組み立て、伴奏の型、声や楽器の音域と特性を生かした書き方（楽器法の初歩）、編曲、我が国の伝統的な音楽の特徴を生かした創作、記譜のしかた、コンピュータを使った創作、著作権の基本を扱う' }],
      ['鑑賞研究', 'kansho-kenkyu', 22, { scope: '作品・作曲家に関する研究、地域や文化的背景に関する研究、音楽とメディアとの関わり、音楽批評。作品を分析して聴く視点、作曲家の生涯と作風の調べ方、世界の諸民族の音楽と文化的背景、録音・放送・配信などメディアと音楽の関わり、根拠を示して批評文を書く方法を扱う' }],
    ],
  },
  {
    chapter: 'chap3-12',
    subject: 'art',
    label: '美術',
    slug: 'bijutsu',
    guide: 'art+artpro',
    courses: [
      ['美術概論', 'gairon', 24, { scope: '美術に関する基礎的な理論（美術の意義と領域、造形の要素と原理、色彩の理論、形と空間、素材と技法の概観）、自然と美術、生活や社会の中の美術（デザインや工芸の役割、美術館と文化財、美術に関わる仕事）、知的財産権と肖像権（著作権の基本、引用、肖像権、制作や発表で気をつけること）' }],
      ['美術史', 'shi', 36, { scope: '日本の美術と文化（縄文・弥生・古墳から、飛鳥・奈良・平安、鎌倉・室町、桃山・江戸、近代まで）、東洋の美術と文化（中国、朝鮮半島、インド、イスラームなど）、西洋の美術と文化（古代、中世、ルネサンス、バロック・ロココ、近代）、現代の美術と文化（20 世紀以降の動向、メディアや社会との関わり）。時代ごとの社会や思想との関わり、様式の特徴、主な作家と作品、地域どうしの交流を扱う' }],
      ['鑑賞研究', 'kansho-kenkyu', 22, { scope: '作品及び作家に関する研究（作品の見方と分析、作家と時代背景の調べ方）、文化財の保存・修復に関する研究（文化財の種類と保護のしくみ、劣化の原因、保存と修復の考え方）、展示企画及び展示構成に関する研究（美術館・博物館の役割、展覧会の企画、展示の構成と解説）、美術批評（根拠を示して批評文を書く方法）' }],
      ['素描', 'sobyo', 22, { scope: 'デッサン、スケッチ、表現材料、鑑賞。このアプリでは描く指導はできないので、ものの見方（形、比例、構造、明暗、質感、空間、遠近法）、デッサンとスケッチのねらいと進め方、鉛筆・木炭・コンテ・ペンなどの材料と用具の特性、人体や静物・風景をとらえる考え方、よくあるつまずきと直し方、すぐれた素描の鑑賞を扱う' }],
      ['構成', 'kosei', 22, { scope: '形体、色彩、材料、平面構成、立体構成、鑑賞。形の要素（点・線・面・立体）、構成の原理（バランス、リズム、プロポーション、対比、統一と変化）、色彩の体系（色相・明度・彩度、表色系、配色、色の見え方と心理）、材料の性質と表情、平面構成と立体構成の考え方と進め方、すぐれた構成作品やデザインの鑑賞を扱う' }],
      ['絵画', 'kaiga', 26, { scope: '日本画、水彩画、油彩画、漫画、イラストレーション、その他の絵画、鑑賞。このアプリでは描く指導はできないので、それぞれの表現形式の特性、絵の具や支持体など材料と用具のしくみと扱い方、主な技法、主題の見つけ方と構想、構図と色彩の考え方、制作の進め方、溶剤や顔料を安全に扱うための注意、絵画作品の鑑賞を扱う' }],
      ['版画', 'hanga', 22, { scope: '木版画、銅版画、リトグラフ、シルクスクリーン、その他の版画、鑑賞。このアプリでは制作の指導はできないので、版画の特性（複数性、間接性）、凸版・凹版・平版・孔版という版のしくみのちがい、それぞれの材料・用具と工程のあらまし、刷りと版の管理（エディション）、刃物や薬品を使う工程の危険と防ぎ方、版画の歴史と作品の鑑賞を扱う' }],
      ['彫刻', 'chokoku', 22, { scope: '彫造、塑造、その他の彫刻及び立体造形、鑑賞。このアプリでは制作の指導はできないので、彫刻の特性（量感、動勢、均衡、空間）、彫造（木、石）と塑造（粘土、石こう、心棒、型取り）の材料・用具と工程のあらまし、金属や樹脂など多様な素材による立体造形、刃物・電動工具・粉じんなどの危険と防ぎ方、彫刻作品の鑑賞を扱う' }],
      ['ビジュアルデザイン', 'visual-design', 24, { scope: 'ビジュアルデザインの基礎（目的と条件、発想、文字と書体、レイアウト、色彩、図と写真）、伝達目的に応じたデザイン（ポスター、マーク・ロゴ、ピクトグラム、編集、パッケージ、広告）、空間デザイン（サイン計画、展示、ディスプレイ）、図法、表示法（投影図、透視図、図表やダイアグラム）、鑑賞。著作権や商標にも触れる' }],
      ['クラフトデザイン', 'craft-design', 24, { scope: 'クラフトデザインの基礎（使う人と目的、機能と美しさ、素材と加工、発想から試作まで）、図法、製図（投影図、寸法、スケッチ、模型）、工芸（陶芸、染織、漆芸、金工、木工、ガラスなどの素材と技法のあらまし）、プロダクトデザイン（生活用品や機器のデザイン、人間工学、ユニバーサルデザイン、生産との関わり）、伝統工芸（各地の伝統的工芸品と技法、継承）、鑑賞。刃物・機械・窯・薬品などを使う工程の危険と防ぎ方にも触れる' }],
      ['情報メディアデザイン', 'media-design', 22, { scope: '情報メディアの基礎（メディアの種類と特性、デジタル画像・音・動画のしくみ、色と解像度、知的財産権）、情報の視覚化（図解、インフォグラフィックス、地図、アイコン、データの見せ方）、伝達、交流、共有（ウェブやアプリの画面設計、インタラクション、使いやすさ、アクセシビリティ、ソーシャルメディアでの発信）、鑑賞' }],
      ['映像表現', 'eizo', 22, { scope: '機器、用具、材料の知識及び使用技術（カメラとレンズのしくみ、露出、照明、音声、写真とアニメーションの原理）、企画、構成、演出（企画書、シナリオ、絵コンテ、構図とカメラワーク、ショットのつなぎ方）、編集、合成、加工（編集の考え方、色の調整、合成、音の編集、書き出し）、鑑賞。撮影や公開での肖像権・著作権、撮影時の安全にも触れる' }],
      ['環境造形', 'kankyo-zokei', 20, { scope: '生活環境と造形（公共空間、景観、パブリックアート、庭や広場）、展示計画と造形（展示空間の計画、動線、照明、模型）、舞台演出と造形（舞台美術、大道具・小道具、照明、衣装）、その他の環境造形（インスタレーション、地域と関わるアートプロジェクト）、鑑賞。大きな構造物の設置や高い所での作業の危険と防ぎ方にも触れる' }],
    ],
  },
  {
    chapter: 'chap3-13',
    subject: 'english',
    label: '英語',
    slug: 'eigo',
    guide: 'english',
    // 英語の指導項目は、どの科目も同じ言葉（「英語の特徴やきまりに関する事項」など）なので、科目の目標にもとづいて書く
    courses: [
      ['総合英語Ⅰ', 'sogo1', 36, { scope: '聞くこと・読むこと・話すこと（やり取り・発表）・書くことの 5 つの領域を総合的に伸ばす。日常的な話題や社会的な話題について、まとまりのある英文を聞いたり読んだりして要点や意図をとらえ、情報や考えを整理して、話したり書いたりして伝え合う。語彙・文法・音声・文章の構成を、英語コミュニケーション I より発展的に扱う' }],
      ['総合英語Ⅱ', 'sogo2', 36, { scope: '総合英語 I の発展。社会的な話題について、複数の英文や資料から必要な情報を読み取り・聞き取り、概要・要点・詳細や書き手の意図をとらえる。情報や考えを論理の構成や展開を工夫して、話したり書いたりして詳しく伝え合う。要約、意見と根拠、説明・描写・比較の表現' }],
      ['総合英語Ⅲ', 'sogo3', 32, { scope: '総合英語 II の発展。幅広い社会的な話題について、長い論説文・評論・報道などを読み取り・聞き取り、複数の資料を比べて課題を多面的に考える。聞き手や読み手を説得できるよう、論理の構成や展開を工夫して、話したり書いたりして伝え合う。抽象的な内容の語彙、複雑な文構造、文体の使い分け' }],
      ['ディベート・ディスカッションⅠ', 'debate1', 24, { scope: '英語でのディスカッションとディベートの基礎。意見と理由の述べ方、賛成・反対の表し方、質問と応答、相手の発言の確認と要約、話し合いの進め方と役割、ディベートの形式（立論・質疑・反駁・まとめ）、論題の分析、証拠の示し方、よく使う表現' }],
      ['ディベート・ディスカッションⅡ', 'debate2', 24, { scope: 'ディベート・ディスカッション I の発展。社会的な話題についての論証（主張・根拠・論拠）、複数の資料を活用した立論、反駁と再反駁、論点の整理と比較、審判の視点、合意の形成を目指すディスカッション、即興で話すための表現' }],
      ['エッセイライティングⅠ', 'essay1', 24, { scope: '英語のパラグラフとエッセイの基礎。トピックセンテンス・支持文・結論文、つなぎ言葉、意見と理由・例の示し方、説明・比較・原因と結果・意見の文章、下書きと推敲のしかた、引用と盗用のちがい' }],
      ['エッセイライティングⅡ', 'essay2', 24, { scope: 'エッセイライティング I の発展。複数の段落から成る論証的なエッセイ（序論・本論・結論、主題文）、反対意見への応答、資料の要約と引用、語調と文体、読み手を意識した構成、推敲と校正' }],
    ],
  },
]

// ───────── 原典を読む ─────────

/** 「Ⅰ」→「I」、読みがなの（かっこ）を外す、など */
const tidy = (text) =>
  text
    .replace(/[\s　]+/g, '')
    .replace(/（[ぁ-ん]+）/g, '')
    .replace(/，/g, '、')
    .replace(/Ⅰ/g, 'I')
    .replace(/Ⅱ/g, 'II')
    .replace(/Ⅲ/g, 'III')
    .replace(/Ⅳ/g, 'IV')
    .replace(/Ⅴ/g, 'V')
    .replace(/Ⅵ/g, 'VI')
    .replace(/［/g, '（')
    .replace(/］/g, '）')

/** 画面に出す名前。「財務会計I」→「財務会計 I」、「スポーツVI」→「スポーツ VI」 */
const display = (name) => tidy(name).replace(/([IV]+)$/, ' $1')

const KANA = 'アイウエオカキクケコサシスセソタチツテト'

/** 原典の表記で、次の項目（「エ …」）が同じ行に続いていることがあるので、分ける */
function splitGlued(label, text) {
  const next = KANA[KANA.indexOf(label) + 1]
  const at = next ? text.search(new RegExp(`(?<=[^ァ-ヶー ])${next} `)) : -1
  return at < 0 ? [text] : [text.slice(0, at), ...splitGlued(next, text.slice(at + 2))]
}

async function readChapter(file) {
  const res = await fetch(`${BASE}${file}.htm`)
  if (!res.ok) throw new Error(`${file}: 読めませんでした（${res.status}）`)
  const html = new TextDecoder('utf-8').decode(await res.arrayBuffer())
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|tr|h\d|li)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
  const lines = text.split(/\n+/).map((l) => l.replace(/[\s　]+/g, ' ').trim()).filter(Boolean)
  const subjects = []
  let current = null
  let inContent = false
  for (const line of lines) {
    if (/^第[０-９0-9]+ ?款/.test(line)) {
      current = null
      continue
    }
    const heading = line.match(/^第([０-９0-9]+) (.+)$/)
    if (heading && line.length < 40) {
      current = { name: tidy(heading[2]), items: [], skipped: [] }
      subjects.push(current)
      inContent = false
      continue
    }
    if (!current) continue
    if (/^[２2] 内 ?容/.test(line)) inContent = true
    else if (/^[３3] 内容の取扱い/.test(line)) inContent = false
    else if (inContent) {
      const top = line.match(/^[(（]([0-9０-９]+)[)）] ?(.+)$/)
      const sub = line.match(/^([ア-ン]) (.+)$/)
      if (top && top[2].length < 60) current.items.push({ title: tidy(top[2]), parts: [] })
      else if (sub && sub[2].length < 50 && current.items.length) current.items.at(-1).parts.push(...splitGlued(sub[1], sub[2]).map(tidy))
      // 項目の形をしているのに長すぎて読み飛ばした行は、あとで目で確かめられるように覚えておく
      else if (top || sub) current.skipped.push(line)
    }
  }
  return subjects
}

// ───────── 科目表の行を作る ─────────

const PRACTICE_NOTE = '学校では実習や課題研究として行う科目。このアプリでは実習そのものは行えないので、取り組む前に知っておくこと、進め方、記録とふり返りのしかた、安全と倫理を扱う。学習指導要領の項目: '

const rows = []
for (const group of SUBJECTS) {
  const source = await readChapter(group.chapter)
  const wanted = group.courses.map(([name]) => tidy(name))
  const found = source.map((s) => s.name)
  if (JSON.stringify(wanted) !== JSON.stringify(found)) {
    throw new Error(`${group.label}: 科目が原典と合いません。\n  表:   ${wanted.join('、')}\n  原典: ${found.join('、')}`)
  }
  group.courses.forEach(([name, slug, lessons, extra = {}], i) => {
    const items = source[i].items.map((item) => item.title + (item.parts.length ? `（${item.parts.join('、')}）` : '')).join('、')
    if (!extra.scope && !items) throw new Error(`${group.label} ${name}: 指導項目を読み取れませんでした。`)
    const scope = extra.scope ?? `${extra.practice ? PRACTICE_NOTE : ''}${items}${group.scopeNote ?? ''}`
    rows.push({
      id: `${SCHOOL}-${group.slug}-${slug}`,
      school: SCHOOL,
      subject: group.subject,
      subjectLabel: group.label,
      label: display(name),
      lessons,
      scope,
      guide: extra.guide ?? group.guide,
      ...(extra.practice ? { practice: true } : {}),
    })
  })
  console.log(`${group.label}: ${group.courses.length} 科目（原典と一致）、授業 ${group.courses.reduce((sum, c) => sum + c[2], 0)} 回`)
  for (const s of source) for (const line of s.skipped) console.log(`  ［読み飛ばした行］${s.name}: ${line.slice(0, 90)}`)
}

const ids = new Set(rows.map((r) => r.id))
if (ids.size !== rows.length) throw new Error('ID が重なっています。')
console.log(`合計 ${rows.length} 科目、授業 ${rows.reduce((sum, r) => sum + r.lessons, 0)} 回`)

// ───────── 書きこむ ─────────

const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'))
const kept = catalog.courses.filter((c) => c.school !== SCHOOL)
const clash = kept.find((c) => ids.has(c.id))
if (clash) throw new Error(`ID がほかの科目と重なっています: ${clash.id}`)
const schools = { ...catalog.schools, [SCHOOL]: SCHOOL_LABEL }
const line = (value) =>
  `{ ${Object.entries(value)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(', ')} }`
const text = `{\n  "schools": ${line(schools)},\n  "courses": [\n${[...kept, ...rows].map((c) => `    ${line(c)}`).join(',\n')}\n  ]\n}\n`
JSON.parse(text)

if (process.argv.includes('--write')) {
  writeFileSync(catalogFile, text, 'utf8')
  console.log(`科目表に書きこみました（全 ${kept.length + rows.length} 科目）。`)
} else {
  for (const row of rows) console.log(`\n${row.id}｜${row.label}（${row.lessons} 回、${row.guide}${row.practice ? '、実習' : ''}）\n  ${row.scope}`)
  console.log('\n書きこむには --write を付けます。')
}
