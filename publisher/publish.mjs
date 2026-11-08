// Instagram 予約投稿（GitHub Actions から定期実行）
//
// queue/*.json に並んだ投稿のうち、時刻が来たものを Instagram API（Instagram ログイン方式）で公開する。
// 二重投稿を防ぐため、2段階で動かす。
//   node publisher/publish.mjs claim    … 時刻が来た queued を publishing に変える（ここで一度コミット・プッシュ）
//   node publisher/publish.mjs publish  … この実行で claim したものだけを公開し、結果を書く
// publishing のまま残ったもの（途中で止まったもの）は自動で再実行せず、unknown にして人の確認を待つ。
//
// 環境変数
//   IG_ACCESS_TOKEN    長期アクセストークン（GitHub Secrets）
//   EXPECTED_USERNAME  投稿先のユーザー名（取り違え防止。例: webcompany_ai_iwamoto）
//   MEDIA_BASE_URL     素材の公開URLの先頭（例: https://hifusiako2400-spec.github.io/instagram-api-test-assets）
//   GRAPH_BASE         既定 https://graph.instagram.com/v24.0（テスト時に差し替え）
//   RUN_ID             実行ID（GitHub Actions の run_id）
//   DRY_RUN=1          API を呼ばずに流れだけ確かめる
//   MAX_LATE_MINUTES   予定時刻からこれ以上遅れたら公開せず late にする（既定 180）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const QUEUE = path.join(ROOT, 'queue');
const GRAPH = process.env.GRAPH_BASE || 'https://graph.instagram.com/v24.0';
const TOKEN = process.env.IG_ACCESS_TOKEN || '';
const MEDIA_BASE = (process.env.MEDIA_BASE_URL || '').replace(/\/$/, '');
const RUN_ID = process.env.RUN_ID || `local-${Date.now()}`;
const DRY = process.env.DRY_RUN === '1';
const MAX_LATE = Number(process.env.MAX_LATE_MINUTES || 180);
const now = new Date();

const readQueue = () => fs.existsSync(QUEUE)
  ? fs.readdirSync(QUEUE).filter((f) => f.endsWith('.json')).sort().map((f) => ({ file: path.join(QUEUE, f), job: JSON.parse(fs.readFileSync(path.join(QUEUE, f), 'utf8')) }))
  : [];
const save = (file, job) => fs.writeFileSync(file, JSON.stringify(job, null, 2) + '\n');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- claim
function claim() {
  let n = 0;
  for (const { file, job } of readQueue()) {
    if (job.status === 'publishing') {
      // 前回の実行が途中で止まった。公開済みか分からないので、人の確認に回す
      job.status = 'unknown';
      job.error = `前回の実行（${job.run_id}）が完了しなかったため、公開されたか不明です。Instagram で確認してください。`;
      save(file, job);
      log('UNKNOWN', job.id);
      continue;
    }
    if (job.status !== 'queued') continue;
    const at = new Date(job.publish_at);
    if (at > now) continue;
    const lateMin = (now - at) / 60000;
    if (lateMin > MAX_LATE) {
      job.status = 'late';
      job.error = `予定時刻から${Math.round(lateMin)}分遅れたため公開していません。公開する場合は publish_at を未来にして status を queued に戻してください。`;
      save(file, job);
      log('LATE', job.id);
      continue;
    }
    job.status = 'publishing';
    job.run_id = RUN_ID;
    job.claimed_at = now.toISOString();
    save(file, job);
    log('CLAIM', job.id);
    n++;
  }
  log(`claim: ${n}件`);
}

// ---------------------------------------------------------------- Instagram API
async function api(method, pathname, params = {}) {
  const url = new URL(GRAPH + pathname);
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  let res;
  if (method === 'GET') {
    for (const [k, v] of body) url.searchParams.set(k, v);
    res = await fetch(url);
  } else {
    res = await fetch(url, { method, body });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new Error(`${method} ${pathname} → ${res.status} ${e.type || ''} ${e.code || ''} ${e.message || JSON.stringify(json)}`.trim());
  }
  return json;
}

async function waitFinished(containerId, timeoutSec) {
  const end = Date.now() + timeoutSec * 1000;
  for (;;) {
    const r = await api('GET', `/${containerId}`, { fields: 'status_code,status' });
    if (r.status_code === 'FINISHED') return;
    if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') throw new Error(`コンテナ ${containerId} が ${r.status_code}: ${r.status || ''}`);
    if (Date.now() > end) throw new Error(`コンテナ ${containerId} の処理が ${timeoutSec} 秒で終わらなかった（${r.status_code}）`);
    await sleep(5000);
  }
}

const mediaUrl = (p) => `${MEDIA_BASE}/${p}`;

async function checkUrl(u, want) {
  const r = await fetch(u, { method: 'HEAD' });
  const ct = r.headers.get('content-type') || '';
  if (!r.ok) throw new Error(`素材URLが開けない（${r.status}）: ${u}`);
  if (want && !ct.startsWith(want)) throw new Error(`素材URLの種類が ${ct}（${want} が必要）: ${u}`);
}

async function publishJob(userId, job) {
  if (!['REEL', 'CAROUSEL', 'POST'].includes(job.type)) throw new Error(`未対応の形式: ${job.type}（REEL・CAROUSEL・POST のみ）`);
  const reel = job.type === 'REEL';
  for (const m of job.media) await checkUrl(mediaUrl(m), reel ? 'video/' : 'image/');
  if (reel && job.cover) await checkUrl(mediaUrl(job.cover), 'image/');

  let creationId;
  if (reel) {
    const p = { media_type: 'REELS', video_url: mediaUrl(job.media[0]), caption: job.caption, share_to_feed: String(job.share_to_feed !== false) };
    if (job.cover) p.cover_url = mediaUrl(job.cover);
    creationId = (await api('POST', `/${userId}/media`, p)).id;
    await waitFinished(creationId, 600);
  } else if (job.type === 'CAROUSEL') {
    const children = [];
    for (const m of job.media) {
      const id = (await api('POST', `/${userId}/media`, { image_url: mediaUrl(m), is_carousel_item: 'true' })).id;
      children.push(id);
    }
    for (const c of children) await waitFinished(c, 180);
    creationId = (await api('POST', `/${userId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: job.caption })).id;
    await waitFinished(creationId, 180);
    job.child_container_ids = children;
  } else {
    creationId = (await api('POST', `/${userId}/media`, { image_url: mediaUrl(job.media[0]), caption: job.caption })).id;
    await waitFinished(creationId, 180);
  }
  job.container_id = creationId;
  // ここから先は「公開されたかもしれない」区間。失敗しても再実行せず unknown にする
  job.publish_called_at = new Date().toISOString();
  const mediaId = (await api('POST', `/${userId}/media_publish`, { creation_id: creationId })).id;
  job.ig_media_id = mediaId;
  try {
    const d = await api('GET', `/${mediaId}`, { fields: 'permalink,timestamp' });
    job.permalink = d.permalink;
  } catch { /* 取得できなくても公開は成功している */ }
}

async function publish() {
  const mine = readQueue().filter(({ job }) => job.status === 'publishing' && job.run_id === RUN_ID);
  if (!mine.length) { log('publish: 対象なし'); return; }
  let failed = 0;
  let userId = null;
  if (!DRY) {
    if (!TOKEN) throw new Error('IG_ACCESS_TOKEN が設定されていません');
    const me = await api('GET', '/me', { fields: 'user_id,username' });
    if (process.env.EXPECTED_USERNAME && me.username !== process.env.EXPECTED_USERNAME) {
      throw new Error(`トークンのアカウントが ${me.username}（期待: ${process.env.EXPECTED_USERNAME}）。投稿を中止しました`);
    }
    userId = me.user_id || me.id;
    log(`account: @${me.username}`);
  }
  for (const { file, job } of mine) {
    job.attempts = (job.attempts || 0) + 1;
    try {
      if (DRY) {
        log('DRY', job.id, job.type, job.media.map(mediaUrl).join(' '));
        job.status = 'queued'; // 試運転では状態を戻す
        delete job.run_id; delete job.claimed_at;
      } else {
        await publishJob(userId, job);
        job.status = 'published';
        job.published_at = new Date().toISOString();
        delete job.error;
        log('PUBLISHED', job.id, job.ig_media_id, job.permalink || '');
      }
    } catch (e) {
      failed++;
      if (job.publish_called_at) {
        job.status = 'unknown';
        job.error = `公開の呼び出し後にエラー。公開されたか Instagram で確認してください: ${e.message}`;
      } else if (job.attempts < 3) {
        job.status = 'queued'; // 公開前の失敗は次の実行で再挑戦（最大3回）
        job.error = e.message;
      } else {
        job.status = 'failed';
        job.error = e.message;
      }
      log('ERROR', job.id, job.status, e.message);
    }
    save(file, job);
  }
  if (failed) process.exitCode = 1; // 失敗を GitHub の通知メールで知らせる
}

const phase = process.argv[2];
if (phase === 'claim') claim();
else if (phase === 'publish') await publish();
else { console.error('使い方: node publisher/publish.mjs claim|publish'); process.exit(2); }
