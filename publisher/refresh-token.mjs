// 長期アクセストークンを更新し、新しいトークンを標準出力に出す（ワークフローが Secrets に保存する）
// Meta の仕様: GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=...
// 有効期限内で、発行から24時間以上たったトークンだけ更新でき、更新後60日有効。
const BASE = process.env.REFRESH_BASE || 'https://graph.instagram.com';
const token = process.env.IG_ACCESS_TOKEN;
if (!token) { console.error('IG_ACCESS_TOKEN がありません'); process.exit(1); }
const url = new URL(BASE + '/refresh_access_token');
url.searchParams.set('grant_type', 'ig_refresh_token');
url.searchParams.set('access_token', token);
const res = await fetch(url);
const j = await res.json().catch(() => ({}));
if (!res.ok || !j.access_token) {
  console.error(`更新に失敗: ${res.status} ${j.error ? j.error.message : JSON.stringify(j)}`);
  process.exit(1);
}
console.error(`更新しました。残り約${Math.round(j.expires_in / 86400)}日`);
process.stdout.write(j.access_token);
