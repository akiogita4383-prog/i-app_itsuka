// いつか帳：共有帳（ログイン・同期・招待・課金）
// iOS アプリで、config.js に Supabase の接続先があるときだけ動く。それ以外では window.ItsukaCloud は null。
//
// 同期の考え方（仕様書「同期方式」）
//   1. 端末側を正として書く。画面は即座に変わる
//   2. 書いたら、前回の状態との差分を「未送信キュー」に積む（localStorage に残るので、アプリを閉じても消えない）
//   3. 通信できればキューを順に送る。失敗したら待ち時間を倍々にして再試行
//   4. 帳を開いたとき・アプリが前面に戻ったときに、updated_at の差分を取りにいく
//   5. 開いている帳は Realtime で他の人の変更を受ける
(function () {
  const CFG = window.ITSUKA_CONFIG || {};
  const enabled = !!window.ITSUKA_NATIVE && !!CFG.supabaseUrl && !!CFG.supabaseAnonKey;
  window.ItsukaCloud = enabled ? createCloud() : null;

  function createCloud() {
    const Cap = window.Capacitor;
    const AppleSignIn = Cap.registerPlugin('AppleSignIn');
    const Store = Cap.registerPlugin('Store');
    const Network = Cap.registerPlugin('Network');

    const LS = {
      get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; } },
      set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
      del(k) { try { localStorage.removeItem(k); } catch (e) {} },
    };
    const K_NBS = 'itsuka-nbs', K_QUEUE = 'itsuka-queue', K_WIFI = 'itsuka-wifi-only';
    const cacheKey = nb => 'itsuka-nb:' + nb;

    let api = null;            // index.html から渡される手綱
    let sb = null;             // Supabase クライアント（必要になってから読む）
    let me = null;             // ログイン中のユーザーID
    let profile = null;        // { display_name, plan, plan_expires_at }
    let current = null;        // 開いている共有帳の id
    let channel = null;
    let authors = {};          // user_id -> { name, status }（開いている帳）
    let members = [];          // 開いている帳のメンバー
    let queue = LS.get(K_QUEUE, []);
    let flushing = false, retryTimer = null, retryWait = 2000, pullTimer = null;
    let net = { connected: true, connectionType: 'wifi' };

    /* ---------------- Supabase ---------------- */
    let libP = null;
    function lib() {
      if (!libP) libP = new Promise((res, rej) => {
        if (window.supabase) return res();
        const s = document.createElement('script');
        s.src = 'vendor/supabase.js'; s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      }).then(() => {
        sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'itsuka-auth' },
        });
        sb.auth.onAuthStateChange((_e, s) => { me = s && s.user ? s.user.id : null; });
      });
      return libP;
    }
    async function client() {
      await lib();
      if (!me) { const { data } = await sb.auth.getSession(); me = data.session ? data.session.user.id : null; }
      return sb;
    }

    /* ---------------- ログイン（Sign in with Apple） ---------------- */
    function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
    async function sha256(s) {
      if (window.crypto && crypto.subtle) return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
      return sha256js(s);
    }
    async function signedIn() { await client(); return !!me; }

    /** ログインしていなければ Sign in with Apple。初回は表示名を聞く。やめたら false */
    async function ensureSignedIn() {
      await client();
      if (!me) {
        const raw = hex(crypto.getRandomValues(new Uint8Array(16)));
        let r;
        try { r = await AppleSignIn.authorize({ nonce: await sha256(raw) }); }
        catch (e) { if (/cancel/i.test(String(e && (e.code || e.message)))) return false; throw e; }
        const { data, error } = await sb.auth.signInWithIdToken({ provider: 'apple', token: r.identityToken, nonce: raw });
        if (error) throw error;
        me = data.user.id;
        await refreshProfile();
        if (!profile || !profile.display_name) {
          const name = await api.askName(r.name || '');
          if (name) await setDisplayName(name);
        }
      } else if (!profile) {
        await refreshProfile();
      }
      return true;
    }
    async function refreshProfile() {
      if (!me) return null;
      const { data } = await sb.from('profiles').select('display_name, plan, plan_expires_at').eq('id', me).maybeSingle();
      profile = data || { display_name: '', plan: 'free', plan_expires_at: null };
      return profile;
    }
    async function setDisplayName(name) {
      name = String(name).trim().slice(0, 20);
      if (!name) return;
      const { error } = await sb.from('profiles').update({ display_name: name }).eq('id', me);
      if (error) throw error;
      profile = { ...(profile || {}), display_name: name };
    }
    async function signOut() {
      await client();
      await sb.auth.signOut().catch(() => {});
      me = null; profile = null;
      forgetShared();
    }
    async function deleteAccount() {
      await client();
      const { error } = await sb.functions.invoke('delete-account', { body: {} });
      if (error) throw error;
      await sb.auth.signOut().catch(() => {});
      me = null; profile = null;
      forgetShared();
    }
    function forgetShared() {
      for (const nb of notebooks()) LS.del(cacheKey(nb.id));
      LS.set(K_NBS, []);
      queue = []; LS.set(K_QUEUE, queue);
      close();
    }

    /* ---------------- いつか帳プラス ---------------- */
    const isPlus = () => !!profile && profile.plan === 'plus' &&
      (!profile.plan_expires_at || new Date(profile.plan_expires_at) > new Date());
    async function products() {
      const ids = [CFG.products.monthly, CFG.products.yearly].filter(Boolean);
      const { products } = await Store.products({ ids });
      return ids.map(id => products.find(p => p.id === id)).filter(Boolean);
    }
    async function verify(jws) {
      if (!jws || !jws.length || !me) return;
      const { error } = await sb.functions.invoke('verify-purchase', { body: { jws } });
      if (error) throw error;
      await refreshProfile();
    }
    async function purchase(id) {
      if (!(await ensureSignedIn())) return 'cancelled';
      const r = await Store.purchase({ id, accountToken: me });
      if (r.status === 'purchased') await verify([r.jws]);
      return r.status;
    }
    async function restore() {
      if (!(await ensureSignedIn())) return false;
      const { jws } = await Store.restore();
      if (jws && jws.length) await verify(jws); else await refreshProfile();
      return isPlus();
    }
    const manage = () => Store.manage();
    // 更新や別の端末での購入はアプリの外で起きる。届いたら検証して反映する
    Store.addListener('transaction', ({ jws }) => { if (me) verify([jws]).then(() => api && api.refreshChrome()).catch(() => {}); });

    /* ---------------- 帳の一覧 ---------------- */
    const notebooks = () => LS.get(K_NBS, []);
    async function refreshNotebooks() {
      await client();
      if (!me) return notebooks();
      const { data, error } = await sb.rpc('notebook_summaries');
      if (error) throw error;
      LS.set(K_NBS, data || []);
      // 外された・削除された帳のキャッシュを片づける
      const alive = new Set((data || []).map(n => n.id));
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('itsuka-nb:') && !alive.has(k.slice(10))) { LS.del(k); i--; }
      }
      return data || [];
    }
    const info = nb => notebooks().find(n => n.id === nb) || null;
    const isOwner = nb => { const n = info(nb); return !!n && n.role === 'owner'; };

    async function createNotebook(name) {
      await client();
      const { data, error } = await sb.rpc('create_notebook', { nb_name: name });
      if (error) throw error;
      await refreshNotebooks();
      return data;
    }
    async function renameNotebook(nb, name) {
      await client();
      const { error } = await sb.from('notebooks').update({ name }).eq('id', nb);
      if (error) throw error;
      await refreshNotebooks();
    }
    async function inviteLink(nb) {
      await client();
      const { data, error } = await sb.rpc('create_invite', { nb, max_uses: 5 });
      if (error) throw error;
      return CFG.inviteBase + '?t=' + encodeURIComponent(data);
    }
    const tokenOf = s => {
      s = String(s || '').trim();
      const m = s.match(/[?&]t=([A-Za-z0-9]+)/);
      return m ? m[1] : /^[A-Za-z0-9]{16,64}$/.test(s) ? s : '';
    };
    async function join(linkOrToken) {
      const token = tokenOf(linkOrToken);
      if (!token) throw new Error('bad link');
      if (!(await ensureSignedIn())) return null;
      const { data, error } = await sb.rpc('request_join', { token });
      if (error) throw error;
      await refreshNotebooks();
      return data && data[0];
    }
    async function listMembers(nb) {
      await client();
      const { data, error } = await sb.rpc('notebook_members', { nb });
      if (error) throw error;
      if (nb === current) members = (data || []).filter(m => m.status === 'active');
      return data || [];
    }
    async function decide(nb, user, approve) {
      const { error } = await sb.rpc('decide_member', { nb, member: user, approve });
      if (error) throw error;
      await refreshNotebooks();
    }
    async function removeMember(nb, user) {
      const { error } = await sb.rpc('remove_member', { nb, member: user });
      if (error) throw error;
    }
    async function leave(nb) {
      await client();
      const { error } = await sb.rpc('leave_notebook', { nb });
      if (error) throw error;
      LS.del(cacheKey(nb)); dropQueue(nb);
      await refreshNotebooks();
    }
    async function deleteNotebook(nb) {
      await client();
      // 写真を先に消す（<nb>/<item>/<photo>.jpg）
      const { data: dirs } = await sb.storage.from('photos').list(nb, { limit: 1000 });
      for (const d of dirs || []) {
        const { data: files } = await sb.storage.from('photos').list(`${nb}/${d.name}`, { limit: 1000 });
        const paths = (files || []).map(f => `${nb}/${d.name}/${f.name}`);
        if (paths.length) await sb.storage.from('photos').remove(paths);
      }
      const { error } = await sb.rpc('delete_notebook', { nb });
      if (error) throw error;
      LS.del(cacheKey(nb)); dropQueue(nb);
      await refreshNotebooks();
    }

    /* ---------------- 帳の中身（端末のキャッシュ） ---------------- */
    function cache(nb) {
      const c = LS.get(cacheKey(nb), null);
      return c && c.items ? c : { items: [], cats: [], base: { items: {}, reviews: {}, photos: {}, cats: {} }, since: null, addcat: null };
    }
    const saveCache = (nb, c) => LS.set(cacheKey(nb), c);
    function load(nb) { const c = cache(nb); return { items: c.items, cats: c.cats, addcat: c.addcat }; }
    function setAddCat(nb, id) { const c = cache(nb); c.addcat = id; saveCache(nb, c); }

    const rowOf = (nb, it) => ({
      id: it.id, notebook_id: nb, category_id: it.cat, text: it.text || '', url: it.url || '', note: it.note || '',
      done: !!it.done, done_at: it.doneAt || null, created: it.created,
      photos: (it.photos || []).map(p => ({ id: p, by: (it.photoBy && it.photoBy[p]) || me })),
    });
    const catRowOf = (nb, c, i) => ({ id: c.id, notebook_id: nb, name: c.name, color: c.color, hint: c.hint || null, sort_order: i });
    const reviewKey = it => JSON.stringify([it.rating || 0, it.review || '']);

    /** 書いた内容をキャッシュに残し、前回との差分を未送信キューに積む */
    function save(nb, items, cats) {
      const c = cache(nb), base = c.base;
      const seen = new Set();
      for (const it of items) {
        seen.add(it.id);
        it.photoBy = it.photoBy || {};
        for (const p of it.photos || []) if (!it.photoBy[p]) it.photoBy[p] = me;
        if (!it.author) it.author = me;
        const prev = base.items[it.id];
        const row = rowOf(nb, it);
        if (prev && prev.deleted) enqueue({ t: 'restore', nb, id: it.id });
        const isNew = !prev || prev.deleted || !prev.row;
        // 変えた項目だけを送る（同じメモの別の項目をほかの人が同時に直しても消さない）
        const fields = isNew ? null : Object.keys(row).filter(k => JSON.stringify(row[k]) !== JSON.stringify(prev.row[k]));
        if (isNew || fields.length) {
          // 写真の本体を先に送る
          const had = new Set(base.photos[it.id] || []);
          for (const p of it.photos || []) if (!had.has(p) && it.photoBy[p] === me) enqueue({ t: 'upload', nb, item: it.id, pid: p });
          for (const p of had) if (!(it.photos || []).includes(p)) enqueue({ t: 'unphoto', nb, item: it.id, pid: p });
          enqueue({ t: 'item', nb, id: it.id, row, isNew, fields });
          base.items[it.id] = { row };
          base.photos[it.id] = (it.photos || []).slice();
        }
        if ((base.reviews[it.id] || reviewKey({})) !== reviewKey(it)) {
          enqueue({ t: 'review', nb, id: it.id, rating: it.rating || 0, review: it.review || '' });
          base.reviews[it.id] = reviewKey(it);
        }
      }
      for (const id of Object.keys(base.items)) {
        if (!seen.has(id) && !base.items[id].deleted) {
          enqueue({ t: 'delete', nb, id });
          base.items[id] = { deleted: true };
        }
      }
      const catSeen = new Set();
      cats.forEach((cat, i) => {
        catSeen.add(cat.id);
        const row = catRowOf(nb, cat, i), key = JSON.stringify(row);
        if (base.cats[cat.id] !== key) { enqueue({ t: 'cat', nb, id: cat.id, row }); base.cats[cat.id] = key; }
      });
      for (const id of Object.keys(base.cats)) {
        if (!catSeen.has(id)) { enqueue({ t: 'uncat', nb, id }); delete base.cats[id]; }
      }
      c.items = items; c.cats = cats;
      saveCache(nb, c);
      persistQueue();
      flush();
      return true;
    }

    /** 別の帳から移してきたメモを、この帳（開いていなくてもよい）に足す */
    function append(nb, it) {
      const c = cache(nb);
      if (!c.cats.length) return false;
      const cat = c.cats.find(x => x.name === it.catName) || c.cats[0];
      const moved = { ...it, cat: cat.id, photoBy: {}, reviews: [], author: me };
      delete moved.catName;
      c.items.push(moved);
      saveCache(nb, c);
      save(nb, c.items, c.cats);
      return true;
    }

    /* ---------------- 未送信キュー ---------------- */
    const opKey = op => `${op.nb}|${op.t}|${op.id || op.item + '/' + op.pid}`;
    function enqueue(op) {
      // 同じメモへの同じ種類の操作は、新しいほうで置き換える（並び順は最初の位置のまま）
      const k = opKey(op);
      const i = op.t === 'item' || op.t === 'review' || op.t === 'cat' ? queue.findIndex(q => opKey(q) === k) : -1;
      if (i < 0) return queue.push(op);
      if (op.t === 'item') {
        const old = queue[i];
        const isNew = old.isNew || op.isNew;
        op = { ...op, isNew, fields: isNew ? null : [...new Set([...(old.fields || []), ...(op.fields || [])])] };
      }
      queue[i] = op;
    }
    const persistQueue = () => LS.set(K_QUEUE, queue);
    function dropQueue(nb) { queue = queue.filter(q => q.nb !== nb); persistQueue(); }
    const pendingFor = nb => queue.filter(q => q.nb === nb).length;
    const pendingIds = nb => new Set(queue.filter(q => q.nb === nb && (q.t === 'item' || q.t === 'review' || q.t === 'delete' || q.t === 'restore')).map(q => q.id));

    const photosAllowed = () => !LS.get(K_WIFI, false) || net.connectionType === 'wifi';

    async function flush() {
      if (flushing || !queue.length) return api && api.syncChanged();
      if (!net.connected) return api && api.syncChanged();
      flushing = true;
      try {
        await client();
        if (!me) return;
        let i = 0;
        while (i < queue.length) {
          const op = queue[i];
          if (op.t === 'upload' && !photosAllowed()) { i++; continue; }   // Wi-Fi になるまで写真は待つ
          try {
            await run(op);
            queue.splice(i, 1);
          } catch (e) {
            if (permanent(e)) {
              console.warn('drop op', op, e);
              queue.splice(i, 1);
              resync(op.nb);   // 拒否された変更は手元からも取り消す（サーバーの状態を丸ごと取り直す）
              if (api) api.toast(e && /not allowed|P0003/i.test(e.message + e.code) ? 'この操作は作成者か書いた人だけができます' : '送れなかった変更がありました', { undo: false });
            } else {
              throw e;
            }
          }
          persistQueue();
        }
        retryWait = 2000;
      } catch (e) {
        console.warn('sync failed, retry in', retryWait, e);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(flush, retryWait);
        retryWait = Math.min(retryWait * 2, 60000);
      } finally {
        flushing = false;
        persistQueue();
        if (api) api.syncChanged();
      }
    }
    // 権限エラーやデータの不整合は、何度送っても通らないので捨てる
    function permanent(e) {
      const code = String((e && (e.code || e.statusCode)) || '');
      const msg = String((e && e.message) || '');
      if (/fetch|network|timeout|Failed to/i.test(msg) && !code) return false;
      return /^(42|23|22|P0)/.test(code) || /^4\d\d$/.test(code) && code !== '408' && code !== '429' || /not allowed|not found|row-level/i.test(msg);
    }
    async function run(op) {
      const chk = r => { if (r && r.error) throw r.error; return r; };
      switch (op.t) {
        case 'item': {
          if (op.isNew || !op.fields) return chk(await sb.from('items').upsert(op.row));
          const patch = {};
          for (const f of op.fields) if (f !== 'id' && f !== 'notebook_id') patch[f] = op.row[f];
          if (!Object.keys(patch).length) return;
          return chk(await sb.from('items').update(patch).eq('id', op.id));
        }
        case 'delete': return chk(await sb.rpc('soft_delete_item', { item: op.id }));
        case 'restore': return chk(await sb.rpc('restore_item', { item: op.id }));
        case 'review':
          return chk(await sb.from('reviews').upsert({ item_id: op.id, notebook_id: op.nb, user_id: me, rating: op.rating, review: op.review },
            { onConflict: 'item_id,user_id' }));
        case 'cat': return chk(await sb.from('categories').upsert(op.row, { onConflict: 'notebook_id,id' }));
        case 'uncat': return chk(await sb.from('categories').delete().match({ notebook_id: op.nb, id: op.id }));
        case 'upload': {
          const blob = await api.getPhoto(op.pid).catch(() => null);
          if (!blob) return;   // 端末から消えた写真は送れない
          const r = await sb.storage.from('photos').upload(`${op.nb}/${op.item}/${op.pid}.jpg`, blob, { upsert: true, contentType: 'image/jpeg' });
          if (r.error && !/exists|Duplicate/i.test(r.error.message)) throw r.error;
          return;
        }
        case 'unphoto': {
          chk(await sb.rpc('remove_photo', { item: op.item, photo: op.pid }));
          await sb.storage.from('photos').remove([`${op.nb}/${op.item}/${op.pid}.jpg`]).catch(() => {});
          return;
        }
      }
    }

    /* ---------------- 取りにいく ---------------- */
    async function pull(nb) {
      await client();
      if (!me) return;
      const c = cache(nb);
      const since = c.since || '1970-01-01T00:00:00Z';
      const all = async (q) => {
        const out = [];
        for (let from = 0; ; from += 1000) {
          const { data, error } = await q().range(from, from + 999);
          if (error) throw error;
          out.push(...data);
          if (data.length < 1000) return out;
        }
      };
      const [rows, revs, cats, who] = await Promise.all([
        all(() => sb.from('items').select('*').eq('notebook_id', nb).gt('updated_at', since).order('updated_at')),
        all(() => sb.from('reviews').select('*').eq('notebook_id', nb).gt('updated_at', since).order('updated_at')),
        sb.from('categories').select('*').eq('notebook_id', nb).order('sort_order').then(r => { if (r.error) throw r.error; return r.data; }),
        sb.rpc('notebook_authors', { nb }).then(r => { if (r.error) throw r.error; return r.data; }),
      ]);
      if (nb === current) authors = Object.fromEntries((who || []).map(a => [a.user_id, { name: a.display_name, status: a.status }]));

      const fresh = cache(nb);   // 取りにいっている間に書かれた分を消さない
      const busy = pendingIds(nb);
      const byId = new Map(fresh.items.map(it => [it.id, it]));
      let max = since;
      for (const r of rows) {
        if (r.updated_at > max) max = r.updated_at;
        if (busy.has(r.id)) continue;
        if (r.deleted_at) {
          byId.delete(r.id);
          fresh.base.items[r.id] = { deleted: true };
          continue;
        }
        const old = byId.get(r.id) || { rating: 0, review: '', reviews: [] };
        const it = {
          ...old, id: r.id, cat: r.category_id, text: r.text, url: r.url, note: r.note,
          photos: (r.photos || []).map(p => p.id), photoBy: Object.fromEntries((r.photos || []).map(p => [p.id, p.by])),
          done: r.done, doneAt: r.done_at, created: r.created, author: r.author_id,
        };
        byId.set(r.id, it);
        fresh.base.items[r.id] = { row: rowOf(nb, it) };
        fresh.base.photos[r.id] = it.photos.slice();
      }
      for (const r of revs) {
        if (r.updated_at > max) max = r.updated_at;
        const it = byId.get(r.item_id); if (!it) continue;
        if (r.user_id === me) {
          if (busy.has(r.item_id)) continue;
          it.rating = r.rating; it.review = r.review;
          fresh.base.reviews[r.item_id] = reviewKey(it);
        } else {
          it.reviews = (it.reviews || []).filter(x => x.user !== r.user_id);
          if (r.rating || r.review) it.reviews.push({ user: r.user_id, rating: r.rating, review: r.review });
        }
      }
      // カテゴリは丸ごと取り直す（送っていない変更があるものは手元を残す）
      const busyCats = new Set(queue.filter(q => q.nb === nb && (q.t === 'cat' || q.t === 'uncat')).map(q => q.id));
      const local = new Map(fresh.cats.map(x => [x.id, x]));
      const merged = (cats || []).map(r => busyCats.has(r.id) && local.has(r.id) ? local.get(r.id)
        : { id: r.id, name: r.name, color: r.color, hint: r.hint || undefined });
      for (const x of fresh.cats) if (busyCats.has(x.id) && !merged.some(m => m.id === x.id)) merged.push(x);
      fresh.base.cats = Object.fromEntries((cats || []).map((r, i) => [r.id, JSON.stringify(catRowOf(nb, { id: r.id, name: r.name, color: r.color, hint: r.hint }, i))]));
      if (merged.length) fresh.cats = merged;
      fresh.items = [...byId.values()];
      fresh.since = max;
      saveCache(nb, fresh);
      if (nb === current && api) api.reload();
    }
    function resync(nb) {
      const c = cache(nb);
      c.since = null;
      c.base.items = Object.fromEntries(Object.entries(c.base.items).filter(([id]) => pendingIds(nb).has(id)));
      saveCache(nb, c);
      schedulePull(nb);
    }
    const schedulePull = nb => { clearTimeout(pullTimer); pullTimer = setTimeout(() => pull(nb).catch(e => console.warn(e)), 400); };

    /* ---------------- 帳を開く・閉じる ---------------- */
    async function open(nb) {
      close();
      current = nb;
      authors = {}; members = [];
      try {
        await client();
        if (!me) return;
        sb.rpc('mark_read', { nb }).then(() => {}, () => {});
        listMembers(nb).then(() => api && api.refreshChrome()).catch(() => {});
        await pull(nb);
        channel = sb.channel('nb:' + nb);
        for (const table of ['items', 'reviews', 'categories']) {
          channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `notebook_id=eq.${nb}` }, () => schedulePull(nb));
        }
        channel.on('postgres_changes', { event: '*', schema: 'public', table: 'members', filter: `notebook_id=eq.${nb}` },
          () => { listMembers(nb).then(() => api && api.refreshChrome()).catch(() => {}); refreshNotebooks().catch(() => {}); });
        channel.subscribe();
        flush();
      } catch (e) {
        console.warn('open failed', e);
      }
    }
    function close() {
      if (channel && sb) sb.removeChannel(channel);
      channel = null; current = null;
    }
    /** アプリが前面に戻ったとき */
    async function resume() {
      if (!(await signedIn())) return;
      refreshProfile().catch(() => {});
      await refreshNotebooks().catch(() => {});
      if (current) { sb.rpc('mark_read', { nb: current }).then(() => {}, () => {}); pull(current).catch(() => {}); }
      flush();
      if (api) api.refreshChrome();
    }

    /* ---------------- 写真 ---------------- */
    async function fetchPhoto(nb, item, pid) {
      await client();
      const { data, error } = await sb.storage.from('photos').download(`${nb}/${item}/${pid}.jpg`);
      if (error) return null;
      return data;
    }

    /* ---------------- 権限（画面の出し分け用。最終判断はサーバー） ---------------- */
    const canDelete = (nb, it) => isOwner(nb) || !it.author || it.author === me;
    const canDropPhoto = (nb, it, pid) => isOwner(nb) || !it.photoBy || !it.photoBy[pid] || it.photoBy[pid] === me;
    const authorName = uid => !uid ? '退会したメンバー'
      : authors[uid] ? (authors[uid].status === 'left' ? '退会したメンバー' : authors[uid].name) : 'メンバー';

    /* ---------------- 通信状態 ---------------- */
    Network.getStatus().then(s => { net = s; }).catch(() => {});
    Network.addListener('networkStatusChange', s => { const was = net.connected; net = s; if (s.connected && (!was || photosAllowed())) flush(); if (api) api.syncChanged(); });

    return {
      init(a) { api = a; },
      // ログイン・アカウント
      signedIn, ensureSignedIn, signOut, deleteAccount, refreshProfile,
      profile: () => profile, me: () => me, setDisplayName,
      // プラス
      isPlus, products, purchase, restore, manage,
      // 帳
      notebooks, refreshNotebooks, info, isOwner, createNotebook, renameNotebook, inviteLink, join, tokenOf,
      listMembers, members: () => members, decide, removeMember, leave, deleteNotebook,
      // 中身
      load, save, append, setAddCat, open, close, resume, pull, fetchPhoto,
      pending: nb => pendingFor(nb), online: () => net.connected,
      wifiOnly: () => LS.get(K_WIFI, false), setWifiOnly: v => { LS.set(K_WIFI, !!v); flush(); },
      canDelete, canDropPhoto, authorName,
    };
  }

  // crypto.subtle が使えないときの SHA-256（nonce のハッシュ用）
  function sha256js(ascii) {
    const rr = (v, n) => (v >>> n) | (v << (32 - n));
    const K = [], H = [];
    let p = 2;
    for (let c = 0; c < 64; p++) {
      let prime = true;
      for (let d = 2; d * d <= p; d++) if (p % d === 0) { prime = false; break; }
      if (!prime) continue;
      if (c < 8) H[c] = (Math.pow(p, 1 / 2) * 4294967296) | 0;
      K[c++] = (Math.pow(p, 1 / 3) * 4294967296) | 0;
    }
    const bytes = [...new TextEncoder().encode(ascii)];
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 7; i >= 0; i--) bytes.push(i > 3 ? 0 : (bitLen >>> (i * 8)) & 255);
    const h = H.slice();
    for (let o = 0; o < bytes.length; o += 64) {
      const w = [];
      for (let i = 0; i < 16; i++) w[i] = (bytes[o + i * 4] << 24) | (bytes[o + i * 4 + 1] << 16) | (bytes[o + i * 4 + 2] << 8) | bytes[o + i * 4 + 3];
      for (let i = 16; i < 64; i++) {
        const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (hh + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    return h.map(v => (v >>> 0).toString(16).padStart(8, '0')).join('');
  }
  window.__itsukaSha256 = sha256js;   // テスト用
})();
