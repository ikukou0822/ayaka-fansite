// 訪客密碼（合言葉）的處理：隨機產生、貼上時的整理、雜湊。
//
// 這組密碼只有一種來源：管理頁用系統的亂數產生器（CSPRNG）取 16 個位元組（128 bit），寫成小寫十六進位、
// 四個字一組。沒有「自己取一組密碼」的入口，登入時也只受理這個格式。
//
// 資料庫裡存的是 HMAC-SHA-256(PEPPER, 密碼)，不是 bcrypt、Argon2 這類刻意算得很慢的雜湊。這個選擇成立的前提是：
// - 密碼本身是 128 bit 的隨機值，不是人取的字。慢速雜湊補的是「人取的密碼可以用字典猜」這個弱點；
//   這裡沒有人取的密碼，所以也沒有可以用字典猜的對象。將來如果要讓人自己取密碼，這個前提就不成立，
//   必須換成合適的密碼雜湊（KDF），並在正式環境實際量過 CPU 用量之後才能開放。
// - PEPPER 是部署平台的 secret，不在資料庫也不在 repo：只拿到資料庫的人沒有 PEPPER，無法自行比對。
// - 驗證只在伺服器上做，而且有限速（見訪客端的 LIMITS）。
// 這些是設計上的前提，不是「不可能被猜中」的保證：密碼寫在訊息裡，看得到那則訊息的人就能登入；
// 亂數產生器、PEPPER 的保管與限速，任何一項出問題，上面的推論都要重新檢查。

import { hmacHex, toHex } from './util.js';

// 正規化時去掉的符號：空白、各種連字號／破折號、中黑點（用碼位寫，原始碼裡不放看不見的字元）
const STRIP = new RegExp('[\\s' + [0x2d, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0x30fb]
  .map((code) => '\\u' + code.toString(16).padStart(4, '0')).join('') + ']', 'g');

// 頭尾不是文字或數字的符號（引號、括號、句號…）：從訊息裡複製時很容易一起選到
const EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/**
 * 比對前的整理：全形→半形（NFKC）、英文字母轉小寫、去掉空白、連字號與中黑點、去掉頭尾的符號。
 * 貼上時多一個空格、少一個「-」、或連引號、句號一起複製到，都算同一組。
 *
 * 這個整理不會讓不同的密碼變成同一組：產生出來的密碼整理之後，就是那 16 個位元組的十六進位寫法（32 個字），
 * 和原本的位元組一對一，128 bit 一個也沒有少（tests/unit.spec.mjs 有對應的測試）。
 */
export function normalizePassword(input) {
  return String(input == null ? '' : input).normalize('NFKC').toLowerCase().replace(STRIP, '').replace(EDGES, '');
}

export const PASSWORD_BYTES = 16;                 // 128 bit
const INVITATION = /^[0-9a-f]{32}$/;

/** 把 16 個位元組寫成邀請密碼：小寫十六進位，四個字一組，用連字號隔開（連字號只是方便閱讀） */
export function formatPassword(bytes) {
  const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (raw.length !== PASSWORD_BYTES) { throw new Error('invitation password needs exactly 16 bytes'); }
  return toHex(raw).match(/.{4}/g).join('-');
}

/** 產生一組新的邀請密碼：16 個位元組直接取自 crypto.getRandomValues，不經過取餘數之類會讓分布不均的換算 */
export function generatePassword() {
  return formatPassword(crypto.getRandomValues(new Uint8Array(PASSWORD_BYTES)));
}

/** 整理之後是不是邀請密碼的格式（32 個十六進位字）。登入時只受理這個格式 */
export function isInvitationPassword(input) {
  return INVITATION.test(normalizePassword(input));
}

/** 存進資料庫的值：HMAC-SHA-256(PEPPER, 正規化後的密碼) */
export function hashPassword(pepper, password) {
  return hmacHex(pepper, 'visitor-password:v1:' + normalizePassword(password));
}

/**
 * 用來確認「訪客端和管理端設定的是同一把 PEPPER」的檢查值。管理端設定密碼時把它存進資料庫，訪客端登入時比對；
 * 兩邊的金鑰不一樣時，密碼永遠比對不上，這個值可以讓訪客端知道是設定出了問題（而不是對方打錯）。
 */
export function pepperCheck(pepper) {
  return hmacHex(pepper, 'pepper-check:v1');
}
