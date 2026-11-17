// JPEG 的檢查與清理：寫進儲存空間的檔案，只有顯示影像需要的部分。
//
// 照片在管理頁上傳前，會先由瀏覽器重新編碼（縮小、轉正）。伺服器這一層不依賴那一步：不論送來的檔案是誰產生的，
// 都把整個檔案的結構從頭走到尾，照「白名單」重新排出一份檔案：
//
//   留下（照原樣抄寫）  量化表 DQT、霍夫曼表 DHT、影像的格式 SOF0／SOF1／SOF2、重新開始的間隔 DRI、掃描資料 SOS
//   重寫成固定內容      JFIF 檔頭（一律寫成固定的 18 個位元組，來源檔的檔頭一個位元組也不抄）、
//                       Adobe 色彩標記（只留「色彩轉換方式」這一個值，其餘欄位寫成固定值）
//   不寫進去            其餘所有區段：Exif（拍攝地點、裝置、時間）、XMP、ICC、IPTC、MPF、JFXX、其他 APPn、註解、
//                       JPGn、標記前面的填充位元組、檔尾多出來的資料（包含接在後面的第二張圖）
//   整個檔案不收        不是 JPEG、被截斷、區段長度與內容對不上、不認得的標記、瀏覽器不支援的編碼方式
//                       （無失真、階層式、算術編碼、12 bit）、不是 1 或 3 個色版、Adobe 標記的內容不合理
//
// JFIF 檔頭裡可以放一張內嵌的縮圖，檔頭後面也可以多塞資料——這些在重寫時都不會帶過去。
// 這是無損的處理：影像的壓縮資料原封不動。也因為不解碼影像，這裡看不到「藏在壓縮資料或畫面裡」的東西；
// 那一層由上傳前的重新編碼負責（整張圖重新壓縮過，原檔的壓縮資料不會留下）。

const SOI = 0xd8, EOI = 0xd9, SOS = 0xda, DQT = 0xdb, DHT = 0xc4, DRI = 0xdd, APP0 = 0xe0, APP14 = 0xee, COM = 0xfe;
const isRestart = (m) => m >= 0xd0 && m <= 0xd7;

/** 固定的 JFIF 檔頭：版本 1.01、沒有單位、長寬比 1:1、沒有縮圖 */
export const JFIF_HEADER = Uint8Array.of(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);

/** 固定格式的 Adobe 標記：版本 100、兩個旗標欄位都是 0，只有最後的「色彩轉換方式」來自原檔（0 或 1） */
export function adobeSegment(transform) {
  return Uint8Array.of(0xff, 0xee, 0x00, 0x0e, 0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, transform);
}

function startsWith(buf, at, end, textValue) {
  if (at + textValue.length > end) { return false; }
  for (let i = 0; i < textValue.length; i++) { if (buf[at + i] !== textValue.charCodeAt(i)) { return false; } }
  return true;
}

function sameBytes(buf, start, end, expected) {
  if (end - start !== expected.length) { return false; }
  for (let i = 0; i < expected.length; i++) { if (buf[start + i] !== expected[i]) { return false; } }
  return true;
}

/** 不留下來的 APPn 區段叫什麼（用來回報） */
function appLabel(marker, buf, at, end) {
  if (marker === APP0) { return 'APP0-extension'; }           // JFXX（縮圖）、第二個 JFIF、其他 APP0
  if (startsWith(buf, at, end, 'Exif\0')) { return 'Exif'; }
  if (startsWith(buf, at, end, 'http://ns.adobe.com/')) { return 'XMP'; }
  if (startsWith(buf, at, end, 'ICC_PROFILE\0')) { return 'ICC'; }
  if (startsWith(buf, at, end, 'Photoshop 3.0\0')) { return 'IPTC'; }
  if (startsWith(buf, at, end, 'MPF\0')) { return 'MPF'; }
  return 'APP' + (marker - 0xe0);
}

/** 量化表區段：每張表是 1 個位元組的編號，加上 64 個（或 128 個）位元組；整段必須剛好用完 */
function validQuantTables(buf, at, end) {
  let i = at, count = 0;
  while (i < end) {
    const precision = buf[i] >> 4, id = buf[i] & 0x0f;
    if (precision > 1 || id > 3) { return false; }
    i += 1 + 64 * (precision + 1);
    count += 1;
  }
  return count > 0 && i === end;
}

/** 霍夫曼表區段：每張表是 1 個位元組的編號、16 個長度計數、再加上計數總和那麼多個符號；整段必須剛好用完 */
function validHuffmanTables(buf, at, end) {
  let i = at, count = 0;
  while (i < end) {
    if ((buf[i] >> 4) > 1 || (buf[i] & 0x0f) > 3 || i + 17 > end) { return false; }
    let symbols = 0;
    for (let k = 1; k <= 16; k++) { symbols += buf[i + k]; }
    if (symbols > 256) { return false; }
    i += 17 + symbols;
    count += 1;
  }
  return count > 0 && i === end;
}

/**
 * 把 JPEG 從頭走到尾，排出清理後的檔案要由哪些片段組成。
 * 成功：{ ok: true, width, height, components, progressive, pieces, meta }
 *   pieces：依序寫出的片段。{ start, end, marker } 是照抄原檔的一段；{ bytes, marker } 是重寫的固定內容
 *   meta：  清理時會去掉或改寫的東西（依出現的順序）。空陣列表示這個檔案已經是清理後的樣子，一個位元組都不會變
 * 失敗：{ ok: false, reason }
 */
export function walkJpeg(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const fail = (reason) => ({ ok: false, reason });
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== SOI) { return fail('not-jpeg'); }
  const u16 = (i) => (buf[i] << 8) | buf[i + 1];
  const pieces = [{ start: 0, end: 2, marker: SOI }];
  const meta = [];
  let pos = 2, frame = null, scans = 0, jfif = false, adobe = null, padded = false;

  for (;;) {
    if (pos + 2 > buf.length) { return fail('truncated'); }
    if (buf[pos] !== 0xff) { return fail('corrupt'); }
    const marker = buf[pos + 1];
    if (marker === 0xff) { pos += 1; padded = true; continue; }     // 標記前面的填充位元組：不抄
    if (marker === EOI) { pieces.push({ start: pos, end: pos + 2, marker }); pos += 2; break; }
    // 沒有長度欄位、或不應該單獨出現的標記：SOI 重複、FF00、掃描資料以外的 RSTn、TEM、保留的 02–BF
    if (marker === SOI || marker < 0xc0 || isRestart(marker)) { return fail('corrupt'); }
    if (pos + 4 > buf.length) { return fail('truncated'); }
    const length = u16(pos + 2);
    const at = pos + 4, end = pos + 2 + length;
    if (length < 2) { return fail('corrupt'); }
    if (end > buf.length) { return fail('truncated'); }

    if (marker === APP0 && !scans && !jfif && end - at >= 14 && startsWith(buf, at, end, 'JFIF\0')) {
      // JFIF 檔頭：一律換成固定的 18 個位元組。內嵌的縮圖、檔頭後面多出來的資料、解析度欄位都不帶過去
      jfif = true;
      if (sameBytes(buf, pos, end, JFIF_HEADER)) {
        pieces.push({ start: pos, end, marker });
      } else {
        const thumbnail = 3 * buf[at + 12] * buf[at + 13];
        const before = meta.length;
        if (thumbnail > 0) { meta.push('JFIF-thumbnail'); }
        if (end - at - 14 !== thumbnail) { meta.push('JFIF-extra-data'); }
        if (meta.length === before) { meta.push('JFIF-header'); }     // 只有版本或解析度欄位和固定值不同
        pieces.push({ bytes: JFIF_HEADER, marker });
      }
    } else if (marker === APP14 && !scans && !adobe && end - at >= 12 && startsWith(buf, at, end, 'Adobe')) {
      // Adobe 色彩標記：內容等到知道色版數之後再檢查（見迴圈後面），這裡先記下位置
      adobe = { transform: buf[at + 11], start: pos, end, extra: end - at > 12, piece: { start: pos, end, marker } };
      pieces.push(adobe.piece);
    } else if (marker >= 0xe0 && marker <= 0xef) {
      meta.push(appLabel(marker, buf, at, end));
    } else if (marker === COM) {
      meta.push('comment');
    } else if (marker >= 0xf0 && marker <= 0xfd) {
      meta.push('JPG' + (marker - 0xf0));
    } else if (marker === DQT) {
      if (!validQuantTables(buf, at, end)) { return fail('corrupt'); }
      pieces.push({ start: pos, end, marker });
    } else if (marker === DHT) {
      if (!validHuffmanTables(buf, at, end)) { return fail('corrupt'); }
      pieces.push({ start: pos, end, marker });
    } else if (marker === DRI) {
      if (length !== 4) { return fail('corrupt'); }
      pieces.push({ start: pos, end, marker });
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      // 影像的格式：一般（baseline／extended）或漸進式，8 bit，1 個或 3 個色版。只能出現一次，而且在掃描資料之前
      if (frame || scans) { return fail('corrupt'); }
      if (length < 8) { return fail('corrupt'); }
      const components = buf[at + 5];
      if (length !== 8 + 3 * components) { return fail('corrupt'); }
      if (buf[at] !== 8 || (components !== 1 && components !== 3)) { return fail('unsupported'); }
      const ids = [];
      for (let c = 0; c < components; c++) {
        const id = buf[at + 6 + 3 * c], sampling = buf[at + 7 + 3 * c], table = buf[at + 8 + 3 * c];
        const h = sampling >> 4, v = sampling & 0x0f;
        if (h < 1 || h > 4 || v < 1 || v > 4 || table > 3 || ids.includes(id)) { return fail('corrupt'); }
        ids.push(id);
      }
      frame = { height: u16(at + 1), width: u16(at + 3), components, ids, progressive: marker === 0xc2 };
      if (!frame.width || !frame.height) { return fail('no-image'); }
      pieces.push({ start: pos, end, marker });
    } else if (marker === SOS) {
      if (!frame) { return fail('corrupt'); }
      const count = buf[at];
      if (length < 6 || count < 1 || count > frame.components || length !== 6 + 2 * count) { return fail('corrupt'); }
      for (let c = 0; c < count; c++) {
        const tables = buf[at + 2 + 2 * c];
        if (!frame.ids.includes(buf[at + 1 + 2 * c]) || (tables >> 4) > 3 || (tables & 0x0f) > 3) { return fail('corrupt'); }
      }
      const from = buf[end - 3], to = buf[end - 2], approx = buf[end - 1];
      if (frame.progressive ? (from > to || to > 63 || (approx >> 4) > 13 || (approx & 0x0f) > 13) : (from !== 0 || to !== 63 || approx !== 0)) { return fail('corrupt'); }
      // 掃描資料：一路找到下一個真正的標記（FF 00 是資料、FF D0–D7 是重新開始的記號，都還在掃描資料裡）
      scans += 1;
      let i = end;
      for (;;) {
        i = buf.indexOf(0xff, i);
        if (i === -1 || i + 1 >= buf.length) { return fail('truncated'); }
        const next = buf[i + 1];
        if (next === 0x00 || isRestart(next)) { i += 2; continue; }
        if (next === 0xff) { i += 1; continue; }
        break;
      }
      // 掃描資料的最後如果接著填充用的 FF（資料裡的 FF 後面一定跟著 00，所以這些不是資料），不抄
      let dataEnd = i;
      while (dataEnd > end && buf[dataEnd - 1] === 0xff) { dataEnd -= 1; padded = true; }
      pieces.push({ start: pos, end: dataEnd, marker });
      pos = i;
      continue;
    } else {
      // 其餘有定義但這裡不收的編碼方式：無失真（C3）、階層式（C5–C7、DE、DF）、算術編碼（C9–CB、CC、CD–CF）、C8、DNL（DC）
      return fail('unsupported');
    }
    pos = end;
  }
  if (!frame || !scans) { return fail('no-image'); }

  if (adobe) {
    // 色彩轉換方式只接受 0（不轉換）或 1（YCbCr）。2 是四個色版（YCCK）用的，其他值沒有定義
    if (adobe.transform > 1) { return fail('bad-adobe'); }
    // 同時有 JFIF 檔頭（表示 YCbCr）又標示「不轉換」：兩個標記互相矛盾，不同的解碼器會解出不同的顏色
    if (frame.components === 3 && jfif && adobe.transform !== 1) { return fail('bad-adobe'); }
    if (frame.components === 1) {
      // 只有一個色版時沒有色彩轉換可言，這個標記用不到
      pieces.splice(pieces.indexOf(adobe.piece), 1);
      meta.push('Adobe');
    } else if (!sameBytes(buf, adobe.start, adobe.end, adobeSegment(adobe.transform))) {
      const i = pieces.indexOf(adobe.piece);
      pieces[i] = { bytes: adobeSegment(adobe.transform), marker: APP14 };
      meta.push(adobe.extra ? 'Adobe-extra-data' : 'Adobe-header');
    }
  }
  if (padded) { meta.push('padding'); }
  if (buf.length - pos > 0) { meta.push('trailing-data'); }
  return { ok: true, width: frame.width, height: frame.height, components: frame.components, progressive: frame.progressive, pieces, meta };
}

/**
 * 檢查：是不是這裡收的 JPEG、尺寸多少、裡面有哪些清理時會去掉或改寫的東西。
 * meta 是空陣列，表示檔案已經是清理後的樣子（stripJpeg 的結果會和它一個位元組都不差）。
 */
export function inspectJpeg(bytes) {
  const walked = walkJpeg(bytes);
  if (!walked.ok) { return walked; }
  return { ok: true, width: walked.width, height: walked.height, meta: walked.meta };
}

/** 清理：回傳只剩下影像本身的檔案 { ok: true, bytes, width, height, removed: [去掉或改寫了哪些] } */
export function stripJpeg(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const walked = walkJpeg(buf);
  if (!walked.ok) { return walked; }
  const size = (piece) => (piece.bytes ? piece.bytes.length : piece.end - piece.start);
  const out = new Uint8Array(walked.pieces.reduce((sum, piece) => sum + size(piece), 0));
  let offset = 0;
  for (const piece of walked.pieces) {
    out.set(piece.bytes || buf.subarray(piece.start, piece.end), offset);
    offset += size(piece);
  }
  return { ok: true, bytes: out, width: walked.width, height: walked.height, removed: walked.meta };
}
