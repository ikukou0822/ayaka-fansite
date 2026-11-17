/* =====================================================================
   data.js — 網站的所有文字與資料都集中在這個檔案。
   想改文案、換照片、加年表、換應援留言，只要改這裡，存檔後 commit、push 到 main 即可。

   規則：
   - 每段文字都有兩個版本：ja（日文）與 zh（繁體中文）。
   - 照片資料的格式和 photos/photos.json 完全相同（src、date、alt_ja、alt_zh、width、height），
     可以直接從 photos.json 複製貼上。
   - 不確定的資料請保持 null，不要自己猜（個人資料的 null 欄位不會顯示在網頁上，確認後填入就會出現）。
   - 公開資料（個人資料、興趣、作品、訪談、年表、官方連結）都要有出處：在該筆資料加上 sources: ['代號']，
     代號對應最下面的 sources 清單（來源名稱、網址、刊登日期、查證日期）。
   ===================================================================== */
window.SITE_DATA = {

  /* ---------- 網站基本設定 ---------- */
  site: {
    defaultLang: 'ja',                       // 預設語言：'ja' 或 'zh'
    storageKey: 'ayaka-fansite:lang',        // 記住語言用的 localStorage 鍵名
    lastUpdated: '2026-11-18',               // 頁尾「最後更新」日期（YYYY-MM-DD）
    birthday: { year: 2003, month: 6, day: 20 }, // 生日（以日本時間計算）
    url: 'https://ikukou0822.github.io/ayaka-fansite/', // 網站網址（分享預覽用；index.html、letter.html 的 canonical 與 og: 標籤也要一起改）
    // 「合言葉のページ」（私密區）的網址：把 backend/ 裡訪客端的 https 網址填在這裡，
    // 首頁「給彩花的信」入口下面才會出現一行小字連結。私密區的驗收與定稿完成之前保持 null（不顯示入口）。
    // 這裡只是一個連結；密碼、照片與回覆都不在這個 repo 裡（見 backend/README.md）
    roomUrl: null,
    // 照片的 WebP 版本：true 時會載入 photos/xxx-480.webp、xxx-800.webp、xxx-full.webp（用 scripts/make_images.py 產生）
    // 換了照片但還沒重新產生 WebP 時，先改成 false，網站就只用 JPEG。
    webp: true,
    title: {
      ja: 'AYAKA（彩花）非公式応援サイト｜NiziU',
      zh: 'AYAKA（彩花）非官方應援網站｜NiziU'
    },
    description: {
      ja: 'NiziU AYAKA（彩花）の非公式応援サイト。プロフィール、バースデーカウントダウン、ヒストリー、フォト、ビデオ通話の思い出、応援メッセージ。',
      zh: 'NiziU 成員 AYAKA（彩花）的非官方應援網站：個人資料、生日倒數、年表、相簿、視訊回憶與應援留言。'
    }
  },

  /* ---------- 首頁主視覺 ---------- */
  hero: {
    eyebrow: { ja: 'NiziU AYAKA 非公式応援サイト', zh: 'NiziU AYAKA 非官方應援網站' },
    name: 'AYAKA',          // 藝名（英文）
    nameKanji: '彩花',      // 漢字
    nameKana: 'あやか',     // 假名
    // ★ 標語：「給彩花的信」裡「はじめに／寫在前面」的第一句（文字和 letter-data.js 完全相同）。
    //    網站主人 2026-11-11 確認沿用；之後想換一句，直接改這兩行。
    slogan: {
      ja: '彩花ちゃんがいてくれるおかげで、ぼくの人生は、前よりもずっと彩り豊かで、幸せなものになりました。',
      zh: '因為有彩花，我的人生變得更有色彩，也更加幸福。'
    },
    sloganNote: { ja: '', zh: '' }, // 標語下方的小字（不需要可留空）
    photo: {
      src: 'photos/ayaka-07.jpg',
      date: '2026-08-23',
      alt_ja: '満面の笑顔',
      alt_zh: '燦爛的笑容',
      width: 1280,
      height: 1600
    }
  },

  /* ---------- 介面文字（按鈕、標題、提示等） ---------- */
  ui: {
    skipLink:        { ja: '本文へスキップ', zh: '跳到主要內容' },
    brandSub:        { ja: '非公式応援サイト', zh: '非官方應援網站' },
    heroCta:         { ja: 'フォトを見る', zh: '看相簿' },
    langLabel:       { ja: '言語を選択', zh: '選擇語言' },
    langJa:          { ja: '日本語', zh: '日本語' },
    langZh:          { ja: '繁體中文', zh: '繁體中文' },
    navLabel:        { ja: 'ページ内ナビゲーション', zh: '頁內導覽' },
    navProfile:      { ja: 'プロフィール', zh: '個人資料' },
    navBirthday:     { ja: 'バースデー', zh: '生日倒數' },
    navTimeline:     { ja: 'ヒストリー', zh: '年表' },
    navWorks:        { ja: '作品', zh: '作品' },
    navGallery:      { ja: 'フォト', zh: '相簿' },
    navMessages:     { ja: 'メッセージ', zh: '應援留言' },
    navAbout:        { ja: 'このサイトについて', zh: '關於本站' },

    profileTitle:    { ja: 'プロフィール', zh: '個人資料' },
    profileLead:     { ja: '確認できている情報だけを載せています。', zh: '只放已經確認的資訊。' },
    placeholder:     { ja: '確認中', zh: '待補' },
    ageSuffix:       { ja: '歳', zh: '歲' },
    // 個人資料下面的小區塊：有年份的興趣（內容在下面的 hobbies）
    hobbiesTitle:    { ja: '趣味', zh: '興趣' },
    hobbiesLead:     { ja: '2025年9月のインタビューで話していた趣味です。', zh: '2025 年 9 月訪談中分享的興趣。' },

    // 出處（各區塊下方可以展開的小清單）與外部連結
    sourcesSummary:  { ja: '出典', zh: '資料來源' },
    sourceDated:     { ja: '{name}（{date}）', zh: '{name}（{date}）' },   // 來源名稱＋刊登日期
    newTab:          { ja: '（新しいタブで開きます）', zh: '（在新分頁開啟）' },   // 只唸給螢幕閱讀器聽，畫面上看不到

    birthdayTitle:   { ja: 'バースデーカウントダウン', zh: '生日倒數' },
    birthdayLead:    { ja: '次の誕生日（6月20日・日本時間）まで、あと', zh: '距離下一個生日（6 月 20 日，日本時間）還有' },
    birthdayUntil:   { ja: '{age}歳のお誕生日を迎えます', zh: '即將迎來 {age} 歲生日' },
    unitDays:        { ja: '日', zh: '天' },
    unitHours:       { ja: '時間', zh: '小時' },
    unitMinutes:     { ja: '分', zh: '分鐘' },
    unitSeconds:     { ja: '秒', zh: '秒' },
    birthdayToday:   { ja: 'AYAKAちゃん、お誕生日おめでとう！', zh: 'AYAKA，生日快樂！' },
    birthdayTodayLead: { ja: '今日は{age}歳のお誕生日。素敵な一年になりますように。', zh: '今天是 {age} 歲生日，祝妳擁有美好的一年。' },
    countdownLabel:  { ja: '誕生日までの残り時間', zh: '距離生日的剩餘時間' },

    timelineTitle:   { ja: 'ヒストリー', zh: '年表' },
    timelineLead:    { ja: '確認できている出来事から、少しずつ書き足していきます。', zh: '先列出已確認的事件，之後再慢慢補上。' },
    dateUnknown:     { ja: '日付：確認中', zh: '日期：待補' },
    timelinePlaceholder: { ja: 'これからの出来事は、確認でき次第ここに追加します。', zh: '之後的事件會在確認後陸續補上。' },
    timelineWorkLink: { ja: '作品の紹介を見る', zh: '看作品介紹' },   // 年表裡連到「作品」區的連結文字

    // 作品與訪談（內容在下面的 works、interviews）
    worksTitle:      { ja: '作品とインタビュー', zh: '作品與訪談' },
    worksLead:       { ja: '作詞に参加した曲と、インタビューで話していたことを、出典つきで紹介します。', zh: '介紹彩花參與作詞的歌曲，以及她在訪談中談到的內容，都附上出處。' },
    worksListTitle:  { ja: 'AYAKAが参加した作品', zh: '彩花參與的作品' },
    workOfficial:    { ja: '公式サイトの作品ページ', zh: '官方網站的作品頁' },
    interviewsTitle: { ja: 'インタビューから', zh: '訪談摘錄' },
    interviewsLead:  { ja: 'インタビューの内容をサイト管理人が短くまとめたもので、本人の言葉そのままではありません。', zh: '以下是網站主人整理的摘要，並非逐字引用。' },

    galleryTitle:    { ja: 'フォト', zh: '相簿' },
    galleryLead:     { ja: '2026年8月23日にイベント会場で撮影した写真と、ビデオ通話の思い出です。写真を選ぶと大きく表示できます。', zh: '2026 年 8 月 23 日在活動現場拍攝的照片，以及視訊回憶。點選照片就能放大瀏覽。' },
    galleryOpen:     { ja: '写真を拡大表示', zh: '放大檢視照片' },
    // 相簿第二組：視訊回憶（照片資料在下面的 callPhotos）
    galleryCallTitle: { ja: 'ビデオ通話の思い出', zh: '視訊回憶' },
    galleryCallLead: { ja: 'ビデオ通話のときのスクリーンショットを、サイト管理人が保存したものです。', zh: '網站主人在視訊時擷取的畫面。' },
    // 第二組每張圖說與燈箱的日期標籤；{date} 會換成日期（日文和第一組一樣用半形空格隔開）
    callPhotoCaptionDate: { ja: '{date} ビデオ通話', zh: '{date}，視訊截圖' },
    lightboxLabel:   { ja: '写真の拡大表示', zh: '照片放大檢視' },
    lightboxClose:   { ja: '閉じる', zh: '關閉' },
    lightboxPrev:    { ja: '前の写真', zh: '上一張' },
    lightboxNext:    { ja: '次の写真', zh: '下一張' },
    lightboxCounter: { ja: '{current} / {total}', zh: '{current} / {total}' },
    // 切換照片時唸給螢幕閱讀器聽的句子（畫面上看不到）
    lightboxAnnounce: { ja: '{total}枚中{current}枚目：{caption}', zh: '第 {current} 張，共 {total} 張：{caption}' },
    lightboxHint:    { ja: '← →キーで切り替え、Escキーで閉じる', zh: '← → 切換，Esc 關閉' },
    lightboxHintTouch: { ja: 'スワイプで切り替え、写真の外をタップで閉じる', zh: '左右滑動切換，點照片外側關閉' },

    messagesTitle:   { ja: 'メッセージ', zh: '應援留言' },
    messageFrom:     { ja: '', zh: '' },   // 每則留言的署名；留空就不顯示（之後若有多位留言者再填）
    // 留言區裡、通往「彩花ちゃんへの手紙」（letter.html）的入口小卡。信的內容在 letter-data.js
    letterEntryTitle:   { ja: '彩花ちゃんへの手紙', zh: '給彩花的信' },
    letterEntryText:    { ja: '短い言葉では伝えきれない気持ちを、一通の手紙に込めました。', zh: '幾句話說不完的心情，寫成了一封信。' },
    letterEntryCta:     { ja: '手紙を読む', zh: '讀這封信' },
    // 信的入口小卡下面的一行小字：通往「合言葉のページ」（另一個網站；上面的 site.roomUrl 有填才會出現）
    roomEntry:          { ja: '合言葉をお持ちの方はこちら', zh: '有通關密語的人請走這裡' },

    aboutTitle:      { ja: 'このサイトについて', zh: '關於本站' },
    // 官方連結（關於本站裡；連結在下面的 links）。linksNote 的 {source} 會換成出處連結
    linksTitle:      { ja: '公式リンク', zh: '官方連結' },
    linksNote:       { ja: 'Instagramのアカウントは、{source}の記事で確認しました。', zh: 'Instagram 帳號依 {source} 的報導確認。' },

    // 「分享這個網站」按鈕（關於本站區塊的最後）。
    // shareText 是系統分享選單裡附在網址旁的一句說明（請保持簡短）；
    // shareCopied 是複製成功後顯示幾秒的提示；shareCopyManual 是無法複製時顯示在網址前面的說明。
    shareLead:       { ja: 'このサイトを気に入っていただけたら、ぜひシェアしてください。', zh: '喜歡這個網站的話，歡迎分享給朋友。' },
    shareButton:     { ja: 'このサイトをシェア', zh: '分享這個網站' },
    shareText:       { ja: 'NiziU AYAKA（彩花）の非公式応援サイトです。', zh: 'NiziU 成員 AYAKA（彩花）的非官方應援網站。' },
    shareCopied:     { ja: 'URLをコピーしました', zh: '已複製網址' },
    shareCopyManual: { ja: 'コピーできませんでした。こちらのURLをお使いください：', zh: '無法自動複製，請手動複製這個網址：' },

    footerUpdated:   { ja: '最終更新：{date}', zh: '最後更新：{date}' },
    noscript:        { ja: 'このサイトはJavaScriptを使用しています。ブラウザのJavaScriptを有効にしてご覧ください。', zh: '本網站需要啟用 JavaScript 才能正常顯示。' },
    photoCaptionDate: { ja: '{date} 撮影', zh: '攝於 {date}' },
    framedNotice:    { ja: 'このページは別のサイトに埋め込まれています。', zh: '這個頁面被嵌入在其他網站裡。' },
    framedOpen:      { ja: 'AYAKA応援サイトを開く', zh: '開啟 AYAKA 應援網站' }
  },

  /* ---------- 個人資料 ----------
     value 為 null 的欄位不會顯示在網頁上（資料留著，確認之後填入 { ja: '…', zh: '…' } 就會出現）。
     sources 是出處的代號（對應最下面的 sources）；value 不是 null 的每一列都要有。
     lang: 'ja' 表示這一列的內容是日文原文（中文版也照樣顯示日文）。 */
  profile: [
    { label: { ja: '名前',      zh: '藝名' },     value: { ja: 'AYAKA（彩花）', zh: 'AYAKA（彩花）' }, sources: ['oricon-2020-profile'] },
    { label: { ja: '本名',      zh: '本名' },     value: { ja: '新井　彩花', zh: '新井彩花' }, sources: ['mynavi-2023-12-06'] },
    { label: { ja: '生年月日',  zh: '出生日期' }, value: { ja: '2003年6月20日', zh: '2003 年 6 月 20 日' }, showAge: true, sources: ['oricon-2020-profile'] },
    { label: { ja: '出身地',    zh: '出身地' },   value: { ja: '東京都', zh: '東京都' }, sources: ['oricon-2020-profile'] },
    { label: { ja: '血液型',    zh: '血型' },     value: { ja: 'A型', zh: 'A 型' }, sources: ['oricon-2020-profile'] },
    // 本人的自我介紹用語（不是官方職稱，也不是暱稱）
    { label: { ja: '自己紹介フレーズ', zh: '自我介紹用語' }, value: { ja: 'NiziUのふわふわビューティー', zh: 'NiziUのふわふわビューティー' }, lang: 'ja', sources: ['realsound-2021-09-10'] },
    { label: { ja: '虹プロジェクト', zh: 'Nizi Project（虹プロジェクト）' }, value: { ja: '最終順位8位', zh: '最終排名第 8\u00a0名' }, sources: ['oricon-2020-06-26'] },
    // 日文「として」中間的 ⁠（WORD JOINER）看不見、也不會被唸出來，只是避免換行時被切成「と／して」；改文字時可以保留或刪掉
    { label: { ja: 'デビュー',  zh: '出道' },     value: { ja: '2020年12月2日、シングル「Step and a step」でNiziUと⁠して正式デビュー', zh: '2020 年 12 月 2 日，以單曲〈Step and a step〉隨 NiziU 正式出道' }, sources: ['niziu-official-profile'] },
    // NIZOO：NiziU 的動物角色。這裡只寫「哪個角色對應 AYAKA」；角色自己的設定與喜好不是彩花本人的資料，不要寫進來
    { label: { ja: 'NIZOOキャラクター', zh: 'NIZOO 角色' }, value: { ja: 'ANO（アノ）／モチーフはナマケモノ', zh: 'ANO（アノ）／原型是樹懶' }, sources: ['realsound-2021-10-22'] },
    // ↓ 還沒有可靠來源的欄位：保持 null（網頁上不顯示）。不要填入推測的身高、體重或 MBTI
    { label: { ja: '身長',      zh: '身高' },     value: null },
    { label: { ja: '趣味・特技', zh: '興趣／專長' }, value: null }
  ],

  /* ---------- 興趣（個人資料下面的小區塊） ----------
     只放「有出處、有年份」的興趣；區塊上方的說明（ui.hobbiesLead）寫明是哪一次訪談。
     新增時照格式加一筆，並確認 ui.hobbiesLead 的年月仍然正確（不同訪談的內容不要混在一起）。 */
  hobbies: {
    sources: ['oricon-2025-09-12'],
    items: [
      {
        label: { ja: 'お菓子作り', zh: '甜點製作' },
        text: {
          ja: 'お菓子作りが好きで、当時はチーズケーキをおいしく作ることにハマっていたそうです。さらに本格的なチーズケーキにも挑戦したい、と話していました。',
          zh: '她說喜歡做甜點，當時正迷上把起司蛋糕做得好吃，還想進一步挑戰更道地的起司蛋糕。'
        }
      },
      {
        label: { ja: '古いカメラ', zh: '舊相機' },
        text: {
          ja: '少し古い中古のカメラを使うことがあり、エモい雰囲気の写りがかわいい、と話していました。',
          zh: '她提到會用比較舊的中古相機，覺得拍出來帶點懷舊氣氛的畫質很可愛。'
        }
      }
    ]
  },

  /* ---------- 年表 ----------
     date 可以寫 'YYYY-MM-DD'、'YYYY-MM' 或 'YYYY'；不確定日期時寫 null。請照日期由早到晚排列，同一天不要重複。
     sources 是出處的代號（對應最下面的 sources）。網站主人自己的經歷沒有出處，改寫 own: true。
     link 是「作品」區某一首歌的 id（works 裡的 id）：加了之後，說明後面會出現「看作品介紹」的連結。
     要留一個空白欄位讓自己之後填，就加一筆 { placeholder: true }。 */
  timeline: [
    {
      date: '2003-06-20',
      title: { ja: '誕生', zh: '出生' },
      note:  { ja: '本名は新井彩花。', zh: '本名新井彩花。' },
      sources: ['oricon-2020-profile', 'mynavi-2023-12-06']
    },
    {
      date: '2020-06-26',
      title: { ja: '虹プロジェクトのデビューメンバーに決定', zh: 'Nizi Project 出道成員確定' },
      note:  { ja: '最終順位は8位。', zh: '最終排名第 8\u00a0名。' },
      sources: ['oricon-2020-06-26']
    },
    {
      date: '2020-06-30',
      title: { ja: '『Make you happy』リリース（プレデビュー）', zh: '《Make you happy》發行（預先出道）' },
      note:  { ja: 'デビュー前に配信されたDigital Mini Album。', zh: '正式出道前推出的數位迷你專輯。' },
      sources: ['niziu-official-profile']
    },
    {
      date: '2020-12-02',
      title: { ja: 'NiziUとして正式デビュー', zh: '隨 NiziU 正式出道' },
      note:  { ja: 'シングル「Step and a step」', zh: '單曲〈Step and a step〉' },
      sources: ['niziu-official-profile']
    },
    // ↓ 2021～2026 年的專輯、演唱會、雜誌封面：2026-11-11 依官方網站與新聞報導查證後加入；
    //   2020 年的完整日期、韓國出道、作詞參與：2026-11-14 加入（出處都在最下面的 sources）
    {
      date: '2021-11-24',
      title: { ja: 'NiziU 1stアルバム『U』リリース', zh: 'NiziU 首張專輯《U》發行' },
      note:  { ja: '', zh: '' },
      sources: ['sony-u']
    },
    {
      date: '2022-08-13',
      title: { ja: 'NiziU 初の単独ツアー', zh: 'NiziU 首次單獨巡演' },
      note:  { ja: '「NiziU Live with U 2022 “Light it Up”」。全国7都市・16公演のアリーナツアー。', zh: '「NiziU Live with U 2022 “Light it Up”」。全國 7 個城市、16 場。' },
      sources: ['tft-light-it-up', 'utaten-light-it-up']
    },
    {
      date: '2022-11-12',
      title: { ja: 'NiziU 初のドーム公演', zh: 'NiziU 首次巨蛋公演' },
      note:  { ja: '「NiziU Live with U 2022 “Burn it Up”」。東京ドーム（11月12・13日）、京セラドーム大阪（12月17・18日）。', zh: '「NiziU Live with U 2022 “Burn it Up”」。東京巨蛋（11 月 12、13 日）、京瓷巨蛋大阪（12 月 17、18 日）。' },
      sources: ['pia-burn-it-up']
    },
    {
      date: '2023-07-01',
      title: { ja: 'NiziU 2度目の全国ツアー', zh: 'NiziU 第二次全國巡演' },
      note:  { ja: '「NiziU Live with U 2023 “ココ!夏 Fes.”」。全国7都市・15公演。9月17・18日にはZOZOマリンスタジアムで初のスタジアムライブ。', zh: '「NiziU Live with U 2023 “ココ!夏 Fes.”」。全國 7 個城市、15 場；9 月 17、18 日在 ZOZO 海洋球場舉行首次體育場演唱會。' },
      sources: ['tft-coco-natsu']
    },
    {
      date: '2023-07-19',
      title: { ja: 'NiziU 2ndアルバム『COCONUT』リリース', zh: 'NiziU 第二張專輯《COCONUT》發行' },
      note:  { ja: '初回生産限定盤Bに収録のユニット曲「LOVE YOURSELF」で、AYAKAが作詞に参加。', zh: '初回生產限定盤 B 收錄的 unit 曲〈LOVE YOURSELF〉，彩花參與作詞。' },
      link: 'love-yourself',
      sources: ['sony-coconut', 'niziu-coconut', 'thefirsttimes-2023-08-01']
    },
    {
      date: '2023-10-30',
      title: { ja: 'NiziU 韓国デビュー', zh: 'NiziU 在韓國出道' },
      note:  { ja: 'Korea 1st Single Album『Press Play』。リード曲は「HEARTRIS」。', zh: '韓國首張單曲專輯《Press Play》，主打歌是〈HEARTRIS〉。' },
      sources: ['niziu-press-play', 'thefirsttimes-2023-10-19']
    },
    {
      date: '2024-11-23',
      title: { ja: 'NiziU 初のウィンターツアー', zh: 'NiziU 首次冬季巡演' },
      note:  { ja: '「NiziU Live with U 2024-2025 “AWAKE”」。全国8都市・18公演（2025年2月23日まで）。', zh: '「NiziU Live with U 2024-2025 “AWAKE”」。全國 8 個城市、18 場（至 2025 年 2 月 23 日）。' },
      sources: ['tft-awake-tour']
    },
    {
      date: '2025-09-06',
      title: { ja: 'NiziU 初のホールツアー', zh: 'NiziU 首次會館巡演' },
      note:  { ja: '「NiziU Live with U 2025 “NEW EMOTION : Face to Face”」。全国21都市・32公演。最終公演は日本武道館（11月22・23日）。', zh: '「NiziU Live with U 2025 “NEW EMOTION : Face to Face”」。全國 21 個城市、32 場，最終場在日本武道館（11 月 22、23 日）。' },
      sources: ['tft-face-to-face']
    },
    {
      date: '2025-11-19',
      title: { ja: 'NiziU 3rdアルバム『New Emotion』リリース', zh: 'NiziU 第三張專輯《New Emotion》發行' },
      note:  { ja: 'リード曲は「♡Emotion」（読み：ラブエモーション）。初回生産限定盤Bに収録のユニット曲「Fairy Magic」では、RIKU・MIIHIと一緒に作詞。', zh: '主打歌是〈♡Emotion〉（讀作 Love Emotion）。初回生產限定盤 B 收錄的 unit 曲〈Fairy Magic〉，由彩花與梨久、未光共同作詞。' },
      link: 'fairy-magic',
      sources: ['sony-new-emotion', 'niziu-new-emotion-b', 'tfm-2025-12-11']
    },
    {
      date: '2026-04-23',
      title: { ja: 'AYAKA、雑誌「NAILEX」の表紙に登場', zh: 'AYAKA 登上雜誌《NAILEX》封面' },
      note:  { ja: '2026年6月号 SPECIAL EDITION。AYAKAのソロ表紙。', zh: '2026 年 6 月號 SPECIAL EDITION，AYAKA 的個人封面。' },
      sources: ['niziu-nailex', 'oricon-nailex', 'nailex']
    },
    {
      date: '2026-06-06',
      title: { ja: 'NiziU 約3年半ぶりのドーム公演', zh: 'NiziU 睽違約三年半的巨蛋公演' },
      note:  { ja: '「NiziU Live with U 2026 “NiziU : THE CINEMA”」。京セラドーム大阪（6月6・7日）、東京ドーム（6月13・14日）。', zh: '「NiziU Live with U 2026 “NiziU : THE CINEMA”」。京瓷巨蛋大阪（6 月 6、7 日）、東京巨蛋（6 月 13、14 日）。' },
      sources: ['niziu-the-cinema', 'pia-the-cinema']
    },
    {
      date: '2026-06-14',
      // ★ 網站主人自己的經歷。標題與說明是網站主人 2026-11-18 確認的文字
      title: { ja: 'コンサート後のサイン会', zh: '演唱會後的簽名會' },
      note:  { ja: '彩花ちゃんに初めて近くで会えた、大切な一日です。', zh: '第一次這麼近地見到彩花，是我很珍惜的一段回憶。' },
      own: true
    },
    {
      date: '2026-07-01',
      title: { ja: 'NiziU ベストアルバム『Portfolio』リリース', zh: 'NiziU 精選輯《Portfolio》發行' },
      note:  { ja: 'NiziU初のベストアルバム。', zh: 'NiziU 的第一張精選輯。' },
      sources: ['niziu-portfolio']
    },
    {
      date: '2026-08-23',
      // ★ 網站主人自己的經歷。標題與說明是網站主人 2026-11-18 提供的文字；活動名稱和「給彩花的信」裡一樣寫 Premium Sign Event。
      //   當天和成員說了什麼沒有記錄，請不要補寫對話或其他情節。說明裡的 \n 是換行（兩句各一行）
      title: { ja: 'Premium Sign Event', zh: 'Premium Sign Event' },
      note:  { ja: '今回は前回よりも少し長くメンバーと話せて、うれしかったです。\n「フォト」に載せているイベント写真は、この日に撮影したものです。', zh: '這次比上次多了一點時間，能和成員們聊上幾句，讓我很開心。\n相簿裡的活動照片都攝於這一天。' },
      own: true
    },
    { placeholder: true }
    /* 新增範例：
    {
      date: '2027-01-01',
      title: { ja: '出来事のタイトル', zh: '事件標題' },
      note:  { ja: '補足（不要なら空文字）', zh: '補充說明（不需要可留空）' }
    },
    */
  ],

  /* ---------- 作品（「作品與訪談」區的上半） ----------
     id       英文代號（網址錨點是 #work-代號；年表的 link 也用它）
     official 官方作品頁的出處代號；sources 是訪談等出處（兩種連結都會列在介紹下面）
     只寫有出處的事實，不引用歌詞。作詞請寫「參與／共同作詞」，不要寫成一個人包辦，也不要寫成作曲。 */
  works: [
    {
      id: 'love-yourself',
      title: 'LOVE YOURSELF',
      members: { ja: 'MAKO・AYAKA・MIIHI', zh: '真子、彩花、未光' },
      release: { ja: '2ndアルバム『COCONUT』初回生産限定盤B（2023年7月19日発売）に収録', zh: '收錄於第二張專輯《COCONUT》初回生產限定盤 B（2023 年 7 月 19 日發行）' },
      text: {
        ja: 'AYAKAは歌唱と作詞に参加。インタビューでは、3人とも前向きな性格で曲調も明るいので、聴いた人の気持ちが明るくなるような歌詞を書いた、と話しています。',
        zh: '彩花參與演唱與作詞。她在訪談中提到，三個人的個性都很正向、曲風也明亮，所以寫下了希望讓聽的人心情跟著明亮起來的歌詞。'
      },
      official: 'niziu-coconut',
      sources: ['thefirsttimes-2023-08-01']
    },
    {
      id: 'fairy-magic',
      title: 'Fairy Magic',
      members: { ja: 'RIKU・AYAKA・MIIHI', zh: '梨久、彩花、未光' },
      release: { ja: '3rdアルバム『New Emotion』初回生産限定盤B（2025年11月19日発売）に収録', zh: '收錄於第三張專輯《New Emotion》初回生產限定盤 B（2025 年 11 月 19 日發行）' },
      text: {
        ja: 'AYAKAは歌唱に加えて、RIKU・MIIHIと一緒に作詞に参加。ラジオ番組「NiziU LOCKS!」で3人が作詞を振り返り、AYAKAは、シンプルなメッセージにしたいという思いがあったと話しています。',
        zh: '彩花除了演唱，也與梨久、未光共同作詞。三人在廣播節目「NiziU LOCKS!」談到作詞的過程，彩花提到當時想傳達的是簡單的訊息。'
      },
      official: 'niziu-new-emotion-b',
      sources: ['tfm-2025-12-11']
    }
  ],

  /* ---------- 訪談摘錄（「作品與訪談」區的下半） ----------
     每一則是網站主人整理的短摘要（不是逐字引用，不加引號冒充原話），一定要有出處（媒體、日期、連結）。
     more 是同一篇訪談的補充（可省略）。不要把整篇訪談搬進來，也不要替本人創造沒說過的話或感受。 */
  interviews: [
    {
      title: { ja: '何気ない会話を大切に', zh: '珍惜平凡的聊天時光' },
      text: {
        ja: 'ちょっとした雑談でも元気が出ることがある。だからメンバーには気軽に声をかけてほしくて、自分はいつもそれを待っている——そんな気持ちを話しています。',
        zh: '她覺得就算只是隨口聊幾句，也能讓人打起精神，所以希望成員們隨時來找她說話；她說自己總是在等大家來搭話。'
      },
      sources: ['cut-2025-02-19']
    },
    {
      // 「真ん中係」是她對自己和成員關係的形容，不是官方職位，也不是舞台上的 center
      title: { ja: '「真ん中係」', zh: '她眼中的「真ん中係」' },
      text: {
        ja: '「NiziUの〇〇係」を聞かれて、自分は「真ん中係」だと答えています。年齢がちょうど真ん中で、メンバーのいろいろな意見を聞いて提案することも多く、年上のメンバーも年下のメンバーも同い年のように仲良くしてくれる、という話でした。',
        zh: '被問到自己是 NiziU 的「什麼係」（負責什麼的人）時，她的回答是「真ん中係」——居中的那一個。年齡剛好在中間，常聽大家各種意見、也會提出想法；年長和年幼的成員都像同齡朋友一樣和她相處。'
      },
      // 歌曲偏好一定要保留「2026 年 5 月受訪時」的時間；這是彩花的選擇，不是網站主人喜歡的歌
      more: {
        ja: '同じインタビューでは、好きな曲に「Paradise」を挙げています（2026年5月時点）。心地よいメロディーと、ライブで見るWithUのペンライトの景色が理由だそうです。',
        zh: '2026 年 5 月受訪時，她選〈Paradise〉為最喜歡的歌，提到聽起來很舒服的旋律，以及演唱會上 WithU 手燈形成的景色。'
      },
      sources: ['realsound-2026-05-22']
    }
  ],

  /* ---------- 相簿 ----------
     格式和 photos/photos.json 相同。換照片時：把新檔放進 photos/，再改這裡的 src、alt、尺寸。 */
  photos: [
    { src: 'photos/ayaka-01.jpg', date: '2026-08-23', alt_ja: '両手でうさぎ耳のポーズ', alt_zh: '雙手比兔耳朵', width: 1162, height: 1452 },
    { src: 'photos/ayaka-02.jpg', date: '2026-08-23', alt_ja: '笑顔で拍手', alt_zh: '笑著拍手', width: 1162, height: 1452 },
    { src: 'photos/ayaka-03.jpg', date: '2026-08-23', alt_ja: '頬杖をついて微笑む', alt_zh: '托著臉微笑', width: 1162, height: 1452 },
    { src: 'photos/ayaka-04.jpg', date: '2026-08-23', alt_ja: '腰に手を当てて', alt_zh: '雙手叉腰', width: 1280, height: 1600 },
    { src: 'photos/ayaka-05.jpg', date: '2026-08-23', alt_ja: 'ミッキーのぬいぐるみと', alt_zh: '抱著米奇玩偶', width: 1280, height: 1600 },
    { src: 'photos/ayaka-06.jpg', date: '2026-08-23', alt_ja: '大きなぬいぐるみを抱えて', alt_zh: '抱著大玩偶', width: 1280, height: 1600 },
    { src: 'photos/ayaka-07.jpg', date: '2026-08-23', alt_ja: '満面の笑顔', alt_zh: '燦爛的笑容', width: 1280, height: 1600 },
    { src: 'photos/ayaka-08.jpg', date: '2026-08-23', alt_ja: 'クッションを持って', alt_zh: '拿著抱枕', width: 1280, height: 1600 },
    { src: 'photos/ayaka-09.jpg', date: '2026-08-23', alt_ja: '花の猫耳カチューシャ', alt_zh: '戴著花朵貓耳髮箍', width: 1280, height: 1600 }
  ],

  /* ---------- 相簿第二組：視訊回憶 ----------
     網站主人和 AYAKA 視訊時自己擷取的畫面（photos/call-01.jpg～call-09.jpg，格式和 photos/call-photos.json 相同）。
     date 是整組共用的日期（'YYYY-MM-DD'；只知道月份時可寫 'YYYY-MM'）；每張沒有自己的 date 時就用這個。
     items 清空時，網頁會自動隱藏整個「視訊回憶」區塊。 */
  callPhotos: {
    date: '2026-10-08',
    items: [
      { src: 'photos/call-01.jpg', alt_ja: '親指を立てて笑う', alt_zh: '比讚的笑容', width: 1204, height: 1505 },
      { src: 'photos/call-02.jpg', alt_ja: '首をかしげて笑う', alt_zh: '歪頭笑', width: 1204, height: 1505 },
      { src: 'photos/call-03.jpg', alt_ja: '真剣な表情', alt_zh: '認真的表情', width: 1204, height: 1505 },
      { src: 'photos/call-04.jpg', alt_ja: '両手を組んで', alt_zh: '雙手交握', width: 1204, height: 1505 },
      { src: 'photos/call-05.jpg', alt_ja: '両手で親指を立てて', alt_zh: '雙手比讚', width: 1204, height: 1505 },
      { src: 'photos/call-06.jpg', alt_ja: '微笑み', alt_zh: '微笑', width: 1204, height: 1505 },
      { src: 'photos/call-07.jpg', alt_ja: '頬杖をついた笑顔', alt_zh: '托腮的笑容', width: 1204, height: 1505 },
      { src: 'photos/call-08.jpg', alt_ja: '目を細めて笑う', alt_zh: '笑得眼睛彎彎', width: 1204, height: 1505 },
      { src: 'photos/call-09.jpg', alt_ja: '両手でハート', alt_zh: '雙手比愛心', width: 1204, height: 1505 }
    ]
  },

  /* ---------- 應援留言 ----------
     目前是空的：這一區只放「給彩花的信」的入口小卡（原本的四則是範例文字，已拿掉）。
     之後想放自己寫的短句，照下面的格式加進來即可（沒有留言時，清單會自動隱藏）：
       { ja: '日文', zh: '中文' }, */
  messages: [],

  /* ---------- 關於這個網站 ---------- */
  about: {
    paragraphs: [
      {
        ja: 'このサイトは、ひとりのWithU（NiziUのファン）が個人で運営している非公式応援サイトです。NiziUおよび所属事務所とは一切関係ありません。',
        zh: '這是一位 WithU（NiziU 粉絲）個人經營的非官方應援網站，與 NiziU 及其所屬公司完全無關。'
      },
      {
        ja: 'イベントの写真は、2026年8月23日に会場でサイト管理人が撮影したものです。ビデオ通話のスクリーンショットは、通話のときにサイト管理人が保存したものです。写真・文章の無断転載はご遠慮ください。',
        zh: '網站上的活動照片，都是網站主人 2026 年 8 月 23 日在活動現場親自拍攝的。視訊畫面則是通話時由網站主人自行擷取的。照片與文字請勿擅自轉載。'
      },
      {
        ja: 'プロフィールやヒストリーは、確認できた情報だけを載せています。確認でき次第、少しずつ書き足していきます。',
        zh: '個人資料與年表只放已經確認的資訊，其餘會在確認後慢慢補上。'
      }
    ]
  },

  /* ---------- 官方連結（關於本站裡） ----------
     只放官方網站與本人帳號。handle 是帳號名稱（顯示在連結後面，不加底線）；
     sources 是「確認這個帳號屬於本人」的出處（會顯示在連結下面的一行小字）。 */
  links: [
    { label: { ja: 'NiziU 公式サイト', zh: 'NiziU 官方網站' }, url: 'https://niziu.com/' },
    { label: { ja: 'AYAKA Instagram', zh: 'AYAKA 的 Instagram' }, handle: '@ayaaaka.__', url: 'https://www.instagram.com/ayaaaka.__/', sources: ['spur-2026-04-17'] }
  ],

  /* ---------- 頁尾 ---------- */
  footer: {
    disclaimer: {
      ja: '非公式ファンサイトです。NiziUおよび所属事務所とは関係ありません。',
      zh: '非官方粉絲網站，與 NiziU 及其所屬公司無關。'
    },
    photoNotice: {
      ja: '写真とビデオ通話のスクリーンショットは、サイト管理人が撮影・保存したものです。無断転載はご遠慮ください。',
      zh: '照片與視訊截圖皆為網站主人拍攝或擷取，請勿轉載。'
    }
  },

  /* ---------- 資料來源 ----------
     上面每一筆公開資料的 sources: ['代號'] 都對應到這裡。
       name      來源名稱（媒體或網站；日文和中文寫法不同時用 { ja, zh }）
       url       網址（一定是 https://）
       published 刊登日期：'YYYY-MM-DD'、'YYYY-MM' 或 'YYYY'；官方網站的常設頁面、或沒有記下日期的報導寫 null
       checked   最近一次打開來源、核對內容的日期（YYYY-MM-DD）
     新增資料時：先打開來源確認內容，再在這裡加一筆，然後在資料上寫 sources: ['代號']。 */
  sources: {
    // ── 個人資料、興趣（2026-11-14 核對）
    // ORICON 的成員介紹特集（AYAKA 的資料欄：生日、血型；RIMA 的介紹提到兩人同為東京出身）。
    // 網站主人的說明是「2020-07-08 刊登、2020-10-30 更新」，但核對時頁面上沒有顯示日期，所以這裡只寫年份。
    'oricon-2020-profile':      { name: 'ORICON NEWS', url: 'https://www.oricon.co.jp/special/54870/4/', published: '2020', checked: '2026-11-14' },
    'mynavi-2023-12-06':        { name: { ja: 'マイナビニュース', zh: 'Mynavi News' }, url: 'https://news.mynavi.jp/article/20231206-2826590/', published: '2023-12-06', checked: '2026-11-14' },
    'oricon-2020-06-26':        { name: 'ORICON NEWS', url: 'https://www.oricon.co.jp/news/2165504/full/', published: '2020-06-26', checked: '2026-11-14' },
    'niziu-official-profile':   { name: { ja: 'NiziU公式サイト', zh: 'NiziU 官方網站' }, url: 'https://niziu.com/s/n123/search/artist', published: null, checked: '2026-11-14' },
    'realsound-2021-09-10':     { name: 'Real Sound', url: 'https://realsound.jp/2021/09/post-856191_2.html', published: '2021-09-10', checked: '2026-11-14' },
    'realsound-2021-10-22':     { name: 'Real Sound', url: 'https://realsound.jp/2021/10/post-886636.html', published: '2021-10-22', checked: '2026-11-14' },
    'oricon-2025-09-12':        { name: 'ORICON NEWS', url: 'https://www.oricon.co.jp/news/2406152/full/', published: '2025-09-12', checked: '2026-11-14' },

    // ── 作品、訪談（2026-11-14 核對）
    'niziu-coconut':            { name: { ja: 'NiziU公式サイト', zh: 'NiziU 官方網站' }, url: 'https://niziu.com/s/n123/page/2ndAlbum_COCONUT', published: null, checked: '2026-11-14' },
    'thefirsttimes-2023-08-01': { name: 'THE FIRST TIMES', url: 'https://www.thefirsttimes.jp/interview/0000309621/', published: '2023-08-01', checked: '2026-11-14' },
    'niziu-new-emotion-b':      { name: { ja: 'NiziU公式サイト', zh: 'NiziU 官方網站' }, url: 'https://niziu.com/s/n123/discography/ESCL-6145-6', published: null, checked: '2026-11-14' },
    'tfm-2025-12-11':           { name: 'TOKYO FM「NiziU LOCKS!」', url: 'https://www.tfm.co.jp/lock/niziu/44861', published: '2025-12-11', checked: '2026-11-14' },
    'cut-2025-02-19':           { name: { ja: 'CUT 編集部日記', zh: 'CUT 編輯部日記' }, url: 'https://rockinon.com/blog/cut/211574', published: '2025-02-19', checked: '2026-11-14' },
    'realsound-2026-05-22':     { name: 'Real Sound', url: 'https://realsound.jp/2026/05/post-2395401.html/amp', published: '2026-05-22', checked: '2026-11-14' },

    // ── 官方連結（Instagram 帳號的確認來源；2026-11-14 核對）
    'spur-2026-04-17':          { name: 'SPUR', url: 'https://spur.hpplus.jp/culture/topics/u2Vheg/', published: '2026-04-17', checked: '2026-11-14' },

    // ── 年表：2026-11-14 加入的項目
    'niziu-press-play':         { name: { ja: 'NiziU公式サイト', zh: 'NiziU 官方網站' }, url: 'https://niziu.com/s/n123/discography/JYPK1732', published: null, checked: '2026-11-14' },
    'thefirsttimes-2023-10-19': { name: 'THE FIRST TIMES', url: 'https://www.thefirsttimes.jp/?p=338854', published: '2023-10-19', checked: '2026-11-14' },

    // ── 年表：2026-11-11 查證後加入的項目（當時沒有記下各篇報導的刊登日期，所以 published 是 null）
    'sony-u':                   { name: 'Sony Music', url: 'https://www.sonymusic.co.jp/artist/niziu/info/532979', published: null, checked: '2026-11-11' },
    'tft-light-it-up':          { name: 'THE FIRST TIMES', url: 'https://www.thefirsttimes.jp/?p=210493', published: null, checked: '2026-11-11' },
    'utaten-light-it-up':       { name: 'UtaTen', url: 'https://utaten.com/news/index/49230', published: null, checked: '2026-11-11' },
    'pia-burn-it-up':           { name: { ja: 'ぴあ', zh: 'Pia' }, url: 'https://lp.p.pia.jp/article/news/252383/index.html', published: null, checked: '2026-11-11' },
    'tft-coco-natsu':           { name: 'THE FIRST TIMES', url: 'https://www.thefirsttimes.jp/?p=327229', published: null, checked: '2026-11-11' },
    'sony-coconut':             { name: 'Sony Music', url: 'https://www.sonymusic.co.jp/artist/niziu/info/552726', published: null, checked: '2026-11-11' },
    'tft-awake-tour':           { name: 'THE FIRST TIMES', url: 'https://www.thefirsttimes.jp/?p=573602', published: null, checked: '2026-11-11' },
    'tft-face-to-face':         { name: 'THE FIRST TIMES', url: 'https://www.thefirsttimes.jp/?p=724303', published: null, checked: '2026-11-11' },
    'sony-new-emotion':         { name: 'Sony Music', url: 'https://www.sonymusic.co.jp/artist/niziu/info/576831', published: null, checked: '2026-11-11' },
    'niziu-nailex':             { name: { ja: 'NiziU公式サイト', zh: 'NiziU 官方網站' }, url: 'https://niziu.com/s/n123/news/detail/12076', published: null, checked: '2026-11-11' },
    'oricon-nailex':            { name: 'ORICON NEWS', url: 'https://www.oricon.co.jp/news/2449247/full/', published: null, checked: '2026-11-11' },
    'nailex':                   { name: 'NAILEX', url: 'https://nailex.jp/magazine/nailex-6-special-editionniziu-ayaka', published: null, checked: '2026-11-11' },
    'niziu-the-cinema':         { name: { ja: 'NiziU公式サイト', zh: 'NiziU 官方網站' }, url: 'https://niziu.com/s/n123/news/detail/12014', published: null, checked: '2026-11-11' },
    'pia-the-cinema':           { name: { ja: 'チケットぴあ', zh: 'Ticket Pia' }, url: 'https://t.pia.jp/en/pia/event/event.do?eventBundleCd=b2667309', published: null, checked: '2026-11-11' },
    'niziu-portfolio':          { name: { ja: 'NiziU公式サイト', zh: 'NiziU 官方網站' }, url: 'https://niziu.com/s/n123/news/detail/12110', published: null, checked: '2026-11-11' }
  }
};
