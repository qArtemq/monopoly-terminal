/* global io */
'use strict';

// Символ денег. Поменяйте здесь, если нужен другой (например, 'М' или '₽').
const CURRENCY = '$';
const MAX_AMOUNT_LEN = 9;

const socket = io();

/* ====================== Утилиты ====================== */

const $ = (id) => document.getElementById(id);

function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
}

function fmt(n) {
    return Number(n).toLocaleString('ru-RU');
}

function money(n) {
    return CURRENCY + fmt(n);
}

const store = {
    get(key, def) {
        try {
            const v = localStorage.getItem(key);
            return v === null ? def : JSON.parse(v);
        } catch (e) {
            console.warn('storage get', e);
            return def;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.warn('storage set', e);
        }
    },
    del(key) {
        try {
            localStorage.removeItem(key);
        } catch (e) {
            console.warn('storage del', e);
        }
    }
};

function toast(msg, kind) {
    const box = $('toasts');
    const el = h('div', 'toast ' + (kind || ''), msg);
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => el.remove(), 2800);
}

/* ====================== Состояние ====================== */

let session = store.get('mono_session', null); // { code, playerId, token, pin, name, host }
let state = null; // последнее состояние комнаты с сервера
let mode = store.get('mono_mode', 'player') === 'bank' ? 'bank' : 'player';
let target = null; // выбранный получатель в терминале
let amountStr = '';
let lastLogSeen = null; // null = состояния ещё не было
let soundOn = store.get('mono_sound', true) !== false;
let busy = false;
let targetsSig = '';
let quickSig = '';
let waitTimer = null; // повторные попытки входа, пока комнаты нет на сервере
let autoBusy = false;

function getMe() {
    if (!state || !session) return null;
    return state.players.find((p) => p.id === session.playerId) || null;
}

// Банкир — тот, кто создал комнату. Только у него есть режим «Банк».
function isHost() {
    return !!(state && session && state.hostId === session.playerId);
}

function playerName(id) {
    const p = state && state.players.find((x) => x.id === id);
    return p ? p.name : '?';
}

/* ====================== Звук (без файлов, через WebAudio) ====================== */

let audioCtx = null;

function getCtx() {
    if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

function playRollSound() {
    if (!soundOn) return;
    const ctx = getCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    for (let i = 0; i < 9; i++) {
        const t = t0 + i * 0.085 + Math.random() * 0.03;
        const len = Math.floor(ctx.sampleRate * 0.04);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let j = 0; j < len; j++) data[j] = (Math.random() * 2 - 1) * (1 - j / len);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 900 + Math.random() * 1800;
        filter.Q.value = 1.2;
        const gain = ctx.createGain();
        gain.gain.value = 0.9 * (1 - i / 12);
        src.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        src.start(t);
    }
}

function playCoin() {
    if (!soundOn) return;
    const ctx = getCtx();
    if (!ctx) return;
    [[988, 0], [1319, 0.09]].forEach(([freq, delay]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t = ctx.currentTime + delay;
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.4);
    });
}

/* ====================== Экраны ====================== */

function showJoin(errorText) {
    $('screen-app').classList.add('hidden');
    $('screen-join').classList.remove('hidden');
    $('join-error').textContent = errorText || '';
    closeMenu();
}

function showApp() {
    $('screen-join').classList.add('hidden');
    $('screen-app').classList.remove('hidden');
    if (session) {
        $('me-name').textContent = session.name;
        $('room-code').textContent = 'Комната ' + session.code;
    }
    if (state) applyState();
}

function clearSession() {
    stopWaiting();
    session = null;
    state = null;
    lastLogSeen = null;
    target = null;
    amountStr = '';
    targetsSig = '';
    quickSig = '';
    store.del('mono_session');
    store.del('mono_backup');
}

let currentTab = 'dice';

function showTab(name) {
    currentTab = name;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
}

/* ====================== Подключение и вход ====================== */

function setConn(ok) {
    $('conn').classList.toggle('hidden', ok);
}

function showJoinError(msg) {
    $('join-error').textContent = msg;
}

function setJoinBusy(b) {
    $('btn-create').disabled = b;
    $('btn-join').disabled = b;
}

function onJoined(res) {
    stopWaiting();
    session = {
        code: res.code,
        playerId: res.playerId,
        token: res.token,
        pin: res.pin,
        name: res.name,
        host: !!res.host
    };
    store.set('mono_session', session);
    store.set('mono_name', res.name);
    // Копия комнаты нужна только банкиру: с ней он поднимет комнату после перезапуска сервера
    if (res.host && typeof res.backup === 'string') store.set('mono_backup', { code: res.code, blob: res.backup });
    else if (!res.host) store.del('mono_backup');
    setJoinBusy(false);
    showApp();
}

// Первый вход по коду и имени (с PIN, если имя уже занято)
function joinRoom(code, name, pin) {
    socket.emit('join_room', { code, name, pin }, (res) => {
        setJoinBusy(false);
        if (res && res.ok) return onJoined(res);
        if (res && res.reason === 'need_pin') {
            $('join-pin').classList.remove('hidden');
            $('join-pin').focus();
        }
        showJoinError(res && res.error ? res.error : 'Не удалось войти');
    });
}

/* ----- Автоматический вход по сохранённой сессии и ожидание банкира ----- */

function getBackup() {
    const b = store.get('mono_backup', null);
    return b && session && b.code === session.code && typeof b.blob === 'string' ? b.blob : null;
}

function stopWaiting() {
    if (waitTimer) clearInterval(waitTimer);
    waitTimer = null;
    $('waiting').classList.add('hidden');
}

function showWaiting() {
    const host = !!(session && session.host);
    const hasCopy = !!getBackup();
    $('waiting-title').textContent = 'Комната не найдена';
    if (host) {
        $('waiting-text').textContent = hasCopy
            ? 'Сервер перезапускался. Восстанавливаем комнату из копии на этом телефоне…'
            : 'Сервер перезапускался, а копии комнаты на этом телефоне нет. Восстановить её не получится.';
    } else {
        $('waiting-text').textContent = 'Похоже, сервер перезапускался. Ждём, пока банкир откроет игру и восстановит комнату…';
    }
    $('waiting').classList.remove('hidden');
    // У банкира без копии повторять нечего
    if (!waitTimer && (!host || hasCopy)) waitTimer = setInterval(autoJoin, 4000);
}

function autoJoin() {
    if (!session || autoBusy || !socket.connected) return;
    autoBusy = true;
    const payload = {
        code: session.code,
        name: session.name,
        playerId: session.playerId,
        token: session.token,
        strict: true // только по ключу: не искать по имени и не создавать нового игрока
    };
    if (session.host) {
        const backup = getBackup();
        if (backup) payload.backup = backup;
    }
    socket.timeout(8000).emit('join_room', payload, (err, res) => {
        autoBusy = false;
        if (err) return; // нет ответа: попробуем при следующем подключении
        if (res && res.ok) return onJoined(res);
        if (res && res.reason === 'no_room') return showWaiting();
        const msg = res && res.error ? res.error : 'Не удалось войти';
        clearSession();
        showJoin(msg);
    });
}

$('waiting-exit').addEventListener('click', () => {
    socket.emit('leave', {});
    clearSession();
    showJoin('');
});

socket.on('connect', () => {
    setConn(true);
    if (session) autoJoin();
});
socket.on('disconnect', () => setConn(false));
socket.on('connect_error', () => setConn(false));

socket.on('state', (s) => {
    state = s;
    if (session) applyState();
});

// Свежая зашифрованная копия комнаты — приходит только банкиру
socket.on('backup', (blob) => {
    if (session && session.host && typeof blob === 'string') {
        store.set('mono_backup', { code: session.code, blob });
    }
});

// Банкир закрыл комнату
socket.on('room_closed', () => {
    // если у кого-то было открыто окно подтверждения — закрываем его
    const no = $('confirm-no');
    if (!$('confirm').classList.contains('hidden') && typeof no.onclick === 'function') no.onclick();
    clearSession();
    showJoin('Комната закрыта');
});

function numOrUndef(v) {
    return String(v).trim() === '' ? undefined : Number(v);
}

$('btn-create').addEventListener('click', () => {
    const name = $('join-name').value.trim();
    if (!name) return showJoinError('Введите имя');
    showJoinError('');
    setJoinBusy(true);
    socket.timeout(8000).emit('create_room', {
        name,
        startBalance: numOrUndef($('create-start').value),
        goAmount: numOrUndef($('create-go').value)
    }, (err, res) => {
        if (err || !res || !res.ok) {
            setJoinBusy(false);
            return showJoinError(err ? 'Нет ответа от сервера' : (res && res.error) || 'Ошибка');
        }
        onJoined(res);
    });
});

$('btn-join').addEventListener('click', () => {
    const name = $('join-name').value.trim();
    const code = $('join-code').value.trim();
    if (!name) return showJoinError('Введите имя');
    if (code.length !== 4) return showJoinError('Код — 4 цифры');
    showJoinError('');
    setJoinBusy(true);
    joinRoom(code, name, $('join-pin').value.trim());
});

// Поле PIN появляется только когда имя уже занято; при смене имени или кода прячем его
function hidePinRow() {
    $('join-pin').classList.add('hidden');
    $('join-pin').value = '';
}
$('join-name').addEventListener('input', hidePinRow);

$('join-pin').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
});

$('join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
    hidePinRow();
});

/* ====================== Применение состояния ====================== */

function applyState() {
    const me = getMe();
    if (!me) {
        clearSession();
        showJoin('Вас нет в этой комнате. Войдите заново.');
        return;
    }
    session.name = me.name;

    // Режим «Банк» — только у создателя комнаты
    const host = isHost();
    if (session.host !== host) {
        session.host = host;
        store.set('mono_session', session);
    }
    $('mode-switch').classList.toggle('hidden', !host);
    if (!host && mode === 'bank') setMode('player');

    // Уведомления о деньгах от других
    const maxId = state.log.length ? state.log[state.log.length - 1].id : 0;
    if (lastLogSeen !== null) {
        const fresh = state.log.filter((e) => e.id > lastLogSeen && e.byId !== me.id);
        notifyFresh(fresh.slice(-3), me);
    }
    lastLogSeen = maxId;

    $('me-name').textContent = me.name;
    $('me-dot').style.background = me.color;
    $('room-code').textContent = 'Комната ' + state.code + (host ? ' · банкир' : '');

    renderPay(me);
    renderLog(me);
    renderRolls();
    if (!$('sheet-menu').classList.contains('hidden')) renderMenu();
}

function notifyFresh(entries, me) {
    entries.forEach((e) => {
        if (e.type === 'reset') {
            toast('Новая игра: у всех по ' + money(e.amount), 'ok');
        } else if (e.toId === me.id && e.amount) {
            toast('+' + money(e.amount) + ' от ' + e.from, 'money');
            playCoin();
            if (navigator.vibrate) navigator.vibrate(80);
        } else if (e.fromId === me.id && e.type === 'take') {
            toast('Банк забрал ' + money(e.amount), 'err');
        }
    });
}

/* ====================== Режим игрок / банк ====================== */

function setMode(m) {
    mode = m === 'bank' ? 'bank' : 'player';
    store.set('mono_mode', mode);
    document.body.classList.toggle('bank', mode === 'bank');
    document.querySelectorAll('#mode-switch button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    target = null;
    targetsSig = '';
    quickSig = '';
    const me = getMe();
    if (me) {
        renderPay(me);
        if (!$('sheet-menu').classList.contains('hidden')) renderMenu();
    }
}

document.querySelectorAll('#mode-switch button').forEach((b) => {
    b.addEventListener('click', () => {
        if (mode !== b.dataset.mode) setMode(b.dataset.mode);
    });
});

/* ====================== Терминал ====================== */

function renderPay(me) {
    const bank = mode === 'bank';
    $('balance').textContent = bank ? '∞' : money(me.balance);
    $('balance-label').textContent = bank ? '🏦 Банк' : 'Ваш баланс';
    $('target-title').textContent = bank ? 'Игрок' : 'Кому перевести';
    $('actions-player').classList.toggle('hidden', bank);
    $('actions-bank').classList.toggle('hidden', !bank);
    renderTargets(me);
    renderQuick();
    renderAmount();
}

function renderTargets(me) {
    const bank = mode === 'bank';
    const list = [];
    if (!bank) list.push({ id: 'bank', name: 'Банк', isBank: true });
    state.players.forEach((p) => {
        if (bank || p.id !== me.id) list.push(p);
    });
    if (!list.some((t) => t.id === target)) target = null;

    // Баланс других игроков виден только в режиме банка
    const sig = mode + '|' + target + '|' + list.map((t) => t.id + ':' + t.name + ':' + (bank ? t.balance : '')).join(',');
    if (sig === targetsSig) return;
    targetsSig = sig;

    const box = $('targets');
    box.textContent = '';
    if (!list.length) {
        box.appendChild(h('div', 'empty-hint', 'Пока никого нет'));
        return;
    }
    list.forEach((t) => {
        const btn = h('button', 'target' + (t.id === target ? ' active' : ''));
        const dot = h('span', 'tdot');
        if (t.isBank) dot.textContent = '🏦';
        else dot.style.background = t.color;
        const info = h('span', 'tinfo');
        info.appendChild(h('span', 'tname', t.name));
        if (bank && !t.isBank) info.appendChild(h('span', 'tbal', money(t.balance)));
        btn.append(dot, info);
        btn.addEventListener('click', () => {
            target = t.id;
            targetsSig = '';
            renderTargets(getMe());
        });
        box.appendChild(btn);
    });
}

function renderQuick() {
    const go = state ? state.goAmount : 0;
    const sig = mode + '|' + go;
    if (sig === quickSig) return;
    quickSig = sig;

    const box = $('quick');
    box.textContent = '';
    if (mode === 'bank' && go > 0) {
        const chip = h('button', 'chip go', 'Старт ' + fmt(go));
        chip.addEventListener('click', () => setAmount(go));
        box.appendChild(chip);
    }
    [10, 50, 100, 500].forEach((n) => {
        const chip = h('button', 'chip', '+' + n);
        chip.addEventListener('click', () => setAmount((Number(amountStr) || 0) + n));
        box.appendChild(chip);
    });
}

function setAmount(n) {
    const max = Math.pow(10, MAX_AMOUNT_LEN) - 1;
    amountStr = n > 0 ? String(Math.min(n, max)) : '';
    renderAmount();
}

function renderAmount() {
    const v = Number(amountStr) || 0;
    $('amount').textContent = money(v);
    $('amount').classList.toggle('zero', v === 0);
}

$('keypad').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const k = b.dataset.k;
    if (k === 'bs') amountStr = amountStr.slice(0, -1);
    else if (amountStr === '' && (k === '0' || k === '000')) return;
    else if ((amountStr + k).length > MAX_AMOUNT_LEN) return;
    else amountStr += k;
    renderAmount();
});

$('amount-clear').addEventListener('click', () => setAmount(0));

function send(event, payload, onOk) {
    if (!socket.connected) {
        toast('Нет связи с сервером', 'err');
        return;
    }
    if (busy) return;
    busy = true;
    socket.timeout(6000).emit(event, payload, (err, res) => {
        busy = false;
        if (err) return toast('Сервер не ответил, проверьте историю', 'err');
        if (res && res.ok) {
            if (onOk) onOk();
        } else {
            toast(res && res.error ? res.error : 'Ошибка', 'err');
        }
    });
}

$('btn-pay').addEventListener('click', async () => {
    const me = getMe();
    if (!me) return;
    const amount = Number(amountStr) || 0;
    if (!target) return toast('Выберите получателя', 'err');
    if (amount <= 0) return toast('Введите сумму', 'err');
    if (amount > me.balance) return toast('Недостаточно денег', 'err');
    const toName = target === 'bank' ? 'Банк' : playerName(target);
    const ok = await confirmDialog('Подтвердите перевод', 'Кому: ' + toName + '\nСумма: ' + money(amount), 'Перевести', false);
    if (!ok) return;
    send('pay', { to: target, amount }, () => {
        toast('Отправлено ' + money(amount) + ' → ' + toName, 'ok');
        setAmount(0);
    });
});

async function bankAction(kind) {
    const amount = Number(amountStr) || 0;
    if (!target) return toast('Выберите игрока', 'err');
    if (amount <= 0) return toast('Введите сумму', 'err');
    const p = state.players.find((x) => x.id === target);
    if (!p) return toast('Игрок не найден', 'err');
    const give = kind === 'give';
    if (!give && p.balance < amount) return toast('У игрока недостаточно денег', 'err');
    const ok = await confirmDialog(
        give ? 'Банк выдаёт' : 'Банк забирает',
        'Игрок: ' + p.name + '\nСумма: ' + money(amount),
        give ? 'Выдать' : 'Забрать',
        !give
    );
    if (!ok) return;
    send(give ? 'bank_give' : 'bank_take', give ? { to: p.id, amount } : { from: p.id, amount }, () => {
        toast((give ? 'Выдано ' : 'Забрано ') + money(amount) + ' · ' + p.name, 'ok');
        setAmount(0);
    });
}

$('btn-give').addEventListener('click', () => bankAction('give'));
$('btn-take').addEventListener('click', () => bankAction('take'));

/* ====================== Окно подтверждения ====================== */

function confirmDialog(title, text, okLabel, danger) {
    return new Promise((resolve) => {
        const box = $('confirm');
        const yes = $('confirm-yes');
        const no = $('confirm-no');
        $('confirm-title').textContent = title;
        $('confirm-text').textContent = text;
        yes.textContent = okLabel || 'OK';
        yes.className = 'btn big ' + (danger ? 'red' : 'primary');
        const done = (value) => {
            box.classList.add('hidden');
            yes.onclick = null;
            no.onclick = null;
            box.onclick = null;
            resolve(value);
        };
        yes.onclick = () => done(true);
        no.onclick = () => done(false);
        box.onclick = (e) => {
            if (e.target === box) done(false);
        };
        box.classList.remove('hidden');
    });
}

/* ====================== История ====================== */

const LOG_ICONS = { pay: '💸', give: '➕', take: '➖', join: '👋', remove: '🚪', reset: '🔄' };

function renderLog(me) {
    const box = $('log-list');
    box.textContent = '';
    if (!state.log.length) {
        box.appendChild(h('div', 'empty-hint', 'Пока операций нет'));
        return;
    }
    state.log.slice().reverse().forEach((e) => {
        const row = h('div', 'log-item');
        row.appendChild(h('div', 'log-icon', LOG_ICONS[e.type] || '•'));

        const main = h('div', 'log-main');
        let title = '';
        let sub = '';
        if (e.type === 'pay') {
            title = e.from + ' → ' + e.to;
        } else if (e.type === 'give') {
            title = 'Банк → ' + e.to;
            sub = 'выдал: ' + e.by;
        } else if (e.type === 'take') {
            title = e.from + ' → Банк';
            sub = 'забрал: ' + e.by;
        } else if (e.type === 'join') {
            title = e.name + ' в игре';
        } else if (e.type === 'remove') {
            title = e.name + ' удалён из игры';
            sub = e.by;
        } else if (e.type === 'reset') {
            title = 'Новая игра: у всех по ' + money(e.amount);
            sub = e.by;
        }
        main.appendChild(h('div', 'log-title', title));
        const time = new Date(e.t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        main.appendChild(h('div', 'log-sub', sub ? time + ' · ' + sub : time));
        row.appendChild(main);

        if ((e.type === 'pay' || e.type === 'give' || e.type === 'take') && e.amount) {
            let cls = 'log-amount';
            let sign = '';
            if (e.toId === me.id) {
                cls += ' in';
                sign = '+';
            } else if (e.fromId === me.id) {
                cls += ' out';
                sign = '−';
            }
            row.appendChild(h('div', cls, sign + money(e.amount)));
        }
        box.appendChild(row);
    });
}

/* ====================== Кубики ====================== */

const FACE_VALUES = { front: 1, back: 6, right: 3, left: 4, top: 2, bottom: 5 };
const FACE_ROT = {
    1: { x: 0, y: 0 },
    6: { x: 0, y: 180 },
    3: { x: 0, y: -90 },
    4: { x: 0, y: 90 },
    2: { x: -90, y: 0 },
    5: { x: 90, y: 0 }
};
const DOT_POS = {
    1: [[2, 2]],
    2: [[1, 1], [3, 3]],
    3: [[1, 1], [2, 2], [3, 3]],
    4: [[1, 1], [1, 3], [3, 1], [3, 3]],
    5: [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3]],
    6: [[1, 1], [2, 1], [3, 1], [1, 3], [2, 3], [3, 3]]
};

function rnd6() {
    const buf = new Uint8Array(1);
    do {
        crypto.getRandomValues(buf);
    } while (buf[0] >= 252);
    return (buf[0] % 6) + 1;
}

function dieTransform(rx, ry, rz) {
    return 'rotateX(' + rx + 'deg) rotateY(' + ry + 'deg) rotateZ(' + rz + 'deg)';
}

function createDie(id) {
    const el = $(id);
    Object.keys(FACE_VALUES).forEach((cls) => {
        const face = h('div', 'face ' + cls);
        DOT_POS[FACE_VALUES[cls]].forEach(([r, c]) => {
            const dot = h('div', 'dot');
            dot.style.gridRow = String(r);
            dot.style.gridColumn = String(c);
            face.appendChild(dot);
        });
        el.appendChild(face);
    });
    const start = FACE_ROT[rnd6()];
    const die = { el, wrap: el.parentElement, rx: start.x, ry: start.y, rz: 0 };
    el.style.transform = dieTransform(die.rx, die.ry, die.rz);
    return die;
}

function spinTo(cur, base) {
    const diff = base - (cur % 360);
    const spins = (Math.floor(Math.random() * 3) + 2) * 360;
    const dir = Math.random() > 0.5 ? 1 : -1;
    return cur + diff + spins * dir;
}

// Высота прыжка: не больше, чем есть свободного места над кубиком
// (с запасом на углы куба, которые выступают при вращении).
function jumpHeight(die) {
    const viewTop = $('view-dice').getBoundingClientRect().top;
    const rect = die.wrap.getBoundingClientRect();
    const room = rect.top - viewTop - rect.height * 0.45 - 6;
    return Math.max(0, Math.min(75, Math.floor(room)));
}

function rollDie(die, value, delay, jump) {
    const base = FACE_ROT[value];
    const from = dieTransform(die.rx, die.ry, die.rz);
    die.rx = spinTo(die.rx, base.x);
    die.ry = spinTo(die.ry, base.y);
    die.rz += (Math.floor(Math.random() * 3) + 2) * 360 * (Math.random() > 0.5 ? 1 : -1);
    const to = dieTransform(die.rx, die.ry, die.rz);
    const duration = 900;

    // Итоговое положение сразу пишем в стиль, анимация «с fill: backwards» держит старое до старта
    die.el.style.transform = to;
    const spin = die.el.animate([{ transform: from }, { transform: to }], {
        duration,
        delay,
        easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
        fill: 'backwards'
    });
    die.wrap.animate([
        { transform: 'translateY(0)', offset: 0, easing: 'ease-out' },
        { transform: 'translateY(' + (-jump) + 'px)', offset: 0.4, easing: 'ease-in' },
        { transform: 'translateY(0)', offset: 0.7, easing: 'ease-out' },
        { transform: 'translateY(' + (-Math.round(jump / 4)) + 'px)', offset: 0.85, easing: 'ease-in' },
        { transform: 'translateY(0)', offset: 1 }
    ], { duration, delay });
    return spin.finished.catch(() => {});
}

let dice = [];
let rolling = false;

function rollDice() {
    if (rolling || dice.length < 2) return;
    rolling = true;
    const a = rnd6();
    const b = rnd6();
    $('dice-total').textContent = '';
    $('dice-detail').textContent = 'Бросаем…';
    $('dice-badge').classList.remove('show');
    $('dice-stage').classList.remove('double');
    playRollSound();

    const jump = jumpHeight(dice[0]);
    Promise.all([rollDie(dice[0], a, 0, jump), rollDie(dice[1], b, 70, jump)]).then(() => {
        rolling = false;
        $('dice-total').textContent = String(a + b);
        $('dice-detail').textContent = a + ' + ' + b;
        if (a === b) {
            $('dice-badge').classList.add('show');
            $('dice-stage').classList.add('double');
        }
        if (socket.connected && session) socket.emit('dice', { a, b });
    });
}

$('view-dice').addEventListener('click', rollDice);

function renderRolls() {
    const box = $('roll-list');
    box.textContent = '';
    const rolls = state.rolls.slice().reverse().slice(0, 3);
    if (!rolls.length) {
        box.appendChild(h('div', 'empty-hint', 'Пока никто не бросал'));
        return;
    }
    rolls.forEach((r) => {
        const p = state.players.find((x) => x.id === r.byId);
        const row = h('div', 'roll-item');
        const dot = h('span', 'cdot');
        dot.style.background = p ? p.color : '#888';
        row.appendChild(dot);
        row.appendChild(h('span', 'rname', r.by));
        row.appendChild(h('span', 'rvals', r.a + ' + ' + r.b + (r.a === r.b ? ' · дубль' : '')));
        row.appendChild(h('span', 'rsum', String(r.a + r.b)));
        box.appendChild(row);
    });
}

/* ====================== Калькулятор ====================== */

let calcExpr = '';
let calcDone = false;
let calcPrev = '';
let calcMsg = '';

function isOpChar(c) {
    return c === '+' || c === '-' || c === '*' || c === '/';
}

function lastNumber() {
    const m = calcExpr.match(/[\d.]*$/);
    return m ? m[0] : '';
}

function stripTrailingOps(e) {
    let s = e;
    while (s && isOpChar(s.slice(-1))) s = s.slice(0, -1);
    return s;
}

function formatNum(v) {
    const s = v.toFixed(6).replace(/\.?0+$/, '');
    return s === '-0' ? '0' : s;
}

function calcEval(e) {
    const tokens = e.match(/\d+\.?\d*|[-+*\/]/g);
    if (!tokens) return null;
    if (tokens[0] === '-') {
        tokens.shift();
        if (!tokens.length) return null;
        tokens[0] = '-' + tokens[0];
    }
    const nums = [parseFloat(tokens[0])];
    if (isNaN(nums[0])) return null;
    const ops = [];
    for (let i = 1; i < tokens.length; i += 2) {
        const op = tokens[i];
        const n = parseFloat(tokens[i + 1]);
        if (!isOpChar(op) || isNaN(n)) return null;
        if (op === '*') nums[nums.length - 1] *= n;
        else if (op === '/') nums[nums.length - 1] /= n;
        else {
            ops.push(op);
            nums.push(n);
        }
    }
    let r = nums[0];
    ops.forEach((op, i) => {
        r = op === '+' ? r + nums[i + 1] : r - nums[i + 1];
    });
    if (!isFinite(r) || Math.abs(r) >= 1e15) return null;
    return r;
}

function prettyExpr(e) {
    return e
        .replace(/(\d+)(\.\d*)?/g, (m, i, d) => i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (d || ''))
        .replace(/\*/g, '×')
        .replace(/\//g, '÷')
        .replace(/-/g, '−')
        .replace(/\./g, ',');
}

function calcDigit(k) {
    if (calcDone) {
        calcExpr = '';
        calcDone = false;
    }
    const num = lastNumber();
    if (num.length + k.length > 12) return;
    if (k === '000' && (num === '' || num === '0')) return;
    if (num === '0') calcExpr = calcExpr.slice(0, -1);
    calcExpr += k;
}

function calcDot() {
    if (calcDone) {
        calcExpr = '';
        calcDone = false;
    }
    const num = lastNumber();
    if (num.indexOf('.') !== -1) return;
    if (num === '') calcExpr += '0';
    calcExpr += '.';
}

function calcOperator(k) {
    calcDone = false;
    if (calcExpr === '') {
        if (k === '-') calcExpr = '-';
        return;
    }
    if (calcExpr === '-') return;
    if (isOpChar(calcExpr.slice(-1))) calcExpr = calcExpr.slice(0, -1);
    calcExpr += k;
}

function calcPercent() {
    const num = lastNumber();
    if (num === '' || num === '.') return;
    calcExpr = calcExpr.slice(0, calcExpr.length - num.length) + formatNum(parseFloat(num) / 100);
    calcDone = false;
}

function calcEquals() {
    const e = stripTrailingOps(calcExpr);
    if (!e || e === '-') return;
    const r = calcEval(e);
    if (r === null) {
        calcExpr = '';
        calcDone = false;
        calcMsg = 'Ошибка';
        return;
    }
    calcPrev = prettyExpr(e) + ' =';
    calcExpr = formatNum(r);
    calcDone = true;
}

function calcPress(k) {
    calcMsg = '';
    if (k === 'C') {
        calcExpr = '';
        calcDone = false;
    } else if (k === 'BS') {
        if (calcDone) {
            calcExpr = '';
            calcDone = false;
        } else {
            calcExpr = calcExpr.slice(0, -1);
        }
    } else if (k === '=') {
        calcEquals();
    } else if (k === '%') {
        calcPercent();
    } else if (k === '.') {
        calcDot();
    } else if (isOpChar(k)) {
        calcOperator(k);
    } else {
        calcDigit(k);
    }
    renderCalc();
}

function renderCalc() {
    const text = calcMsg || prettyExpr(calcExpr) || '0';
    const exprEl = $('calc-expr');
    exprEl.textContent = text;
    exprEl.style.fontSize = text.length > 16 ? '24px' : text.length > 11 ? '32px' : '44px';
    $('calc-prev').textContent = calcDone ? calcPrev : '';

    let preview = '';
    if (!calcDone && !calcMsg) {
        const e = stripTrailingOps(calcExpr);
        if (/[\d.][-+*\/][\d.]/.test(e)) {
            const r = calcEval(e);
            if (r !== null) preview = '= ' + prettyExpr(formatNum(r));
        }
    }
    $('calc-res').textContent = preview;
}

$('calc-keys').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) calcPress(b.dataset.k);
});

$('calc-use').addEventListener('click', () => {
    const e = stripTrailingOps(calcExpr);
    const r = e ? calcEval(e) : null;
    if (r === null) return toast('Сначала посчитайте сумму', 'err');
    const v = Math.round(r);
    if (v <= 0) return toast('Сумма должна быть больше нуля', 'err');
    if (String(v).length > MAX_AMOUNT_LEN) return toast('Слишком большая сумма', 'err');
    setAmount(v);
    showTab('pay');
    toast('Сумма в терминале: ' + money(v), 'ok');
});

/* ====================== Меню ====================== */

function openMenu() {
    renderMenu();
    $('sheet-menu').classList.remove('hidden');
}

function closeMenu() {
    $('sheet-menu').classList.add('hidden');
}

function renderMenu() {
    if (!state) return;
    const me = getMe();
    $('menu-code').textContent = state.code;
    $('menu-pin').textContent = session && session.pin ? session.pin : '—';
    $('btn-sound').textContent = soundOn ? '🔊 Звук: вкл' : '🔇 Звук: выкл';
    $('bank-tools').classList.toggle('hidden', !(isHost() && mode === 'bank'));
    $('btn-close-room').classList.toggle('hidden', !isHost());

    const box = $('players-manage');
    box.textContent = '';
    state.players.forEach((p) => {
        const row = h('div', 'pm-row');
        row.appendChild(h('span', 'presence' + (p.online ? ' on' : '')));
        const dot = h('span', 'cdot');
        dot.style.background = p.color;
        row.appendChild(dot);
        row.appendChild(h('span', 'pm-name', p.name));
        row.appendChild(h('span', 'pm-bal', money(p.balance)));
        if (!me || p.id !== me.id) {
            const del = h('button', 'pm-del', '✕');
            del.addEventListener('click', async () => {
                const ok = await confirmDialog('Удалить игрока?', p.name + ' будет удалён из игры вместе с балансом ' + money(p.balance) + '.', 'Удалить', true);
                if (ok) send('remove_player', { id: p.id }, () => toast('Игрок удалён', 'ok'));
            });
            row.appendChild(del);
        }
        box.appendChild(row);
    });
}

$('btn-menu').addEventListener('click', openMenu);
$('menu-close').addEventListener('click', closeMenu);
$('sheet-menu').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeMenu();
});

$('btn-sound').addEventListener('click', () => {
    soundOn = !soundOn;
    store.set('mono_sound', soundOn);
    renderMenu();
});

async function shareRoom() {
    if (!session) return;
    const url = location.origin + '/?room=' + session.code;
    try {
        if (navigator.share) {
            await navigator.share({ title: 'Монополия', text: 'Заходи в игру, код комнаты ' + session.code, url });
            return;
        }
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(url);
            toast('Ссылка скопирована', 'ok');
            return;
        }
    } catch (e) {
        if (e && e.name === 'AbortError') return;
        console.warn('share', e);
    }
    window.prompt('Скопируйте ссылку', url);
}

$('btn-share').addEventListener('click', shareRoom);

$('btn-reset').addEventListener('click', async () => {
    if (!state) return;
    const ok = await confirmDialog(
        'Начать заново?',
        'У всех игроков будет по ' + money(state.startBalance) + ', история очистится.',
        'Сбросить',
        true
    );
    if (ok) send('reset_game', {}, () => toast('Игра сброшена', 'ok'));
});

$('btn-close-room').addEventListener('click', async () => {
    if (!state || !isHost()) return;
    const ok = await confirmDialog(
        'Закрыть комнату?',
        'Комната ' + state.code + ' будет удалена у всех игроков вместе с балансами и историей. Отменить это нельзя.',
        'Закрыть',
        true
    );
    if (ok) send('close_room', {});
});

$('btn-leave').addEventListener('click', async () => {
    const ok = await confirmDialog(
        'Выйти из комнаты?',
        'Ваш счёт сохранится. Вернуться можно по коду комнаты, имени и своему PIN (он в меню ⚙️, запомните его).',
        'Выйти',
        true
    );
    if (!ok) return;
    socket.emit('leave', {});
    clearSession();
    showJoin('');
});

/* ====================== Вкладки ====================== */

document.querySelectorAll('.tab').forEach((b) => {
    b.addEventListener('click', () => showTab(b.dataset.tab));
});

/* ====================== Экран не гаснет ====================== */

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
    } catch (e) {
        console.warn('wakeLock', e);
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestWakeLock();
});

// Первый тап: разблокируем звук и просим не гасить экран
function onFirstTouch() {
    document.removeEventListener('click', onFirstTouch);
    getCtx();
    requestWakeLock();
}
document.addEventListener('click', onFirstTouch);

// Запрет зума щипком на iOS
document.addEventListener('gesturestart', (e) => e.preventDefault());

/* ====================== Старт ====================== */

function boot() {
    $('join-name').value = store.get('mono_name', '');
    const params = new URLSearchParams(location.search);
    const roomParam = params.get('room');
    if (roomParam) $('join-code').value = roomParam.replace(/\D/g, '').slice(0, 4);

    // Режим «Банк» есть только у создателя комнаты (точно подтвердит сервер после подключения)
    const isBanker = !!(session && session.host);
    if (!isBanker) mode = 'player';
    $('mode-switch').classList.toggle('hidden', !isBanker);

    document.body.classList.toggle('bank', mode === 'bank');
    document.querySelectorAll('#mode-switch button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));

    dice = [createDie('die-1'), createDie('die-2')];
    renderCalc();
    renderAmount();
    showTab('dice');

    if (session) showApp();
    else showJoin('');
}

boot();
