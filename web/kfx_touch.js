// Touch screens and game controllers for the game on the Play page.
//
// Touch: the page reads the fingers on the game and drives the game through
// src/kfx/platform/web/WebInput.cpp, so SDL never sees them. A touch puts the
// game cursor under the finger (no pointer lock, no drift when the game moves
// its cursor).
//   tap                 left click            (dig, build, pick up, buttons)
//   drag                left button held      (mark tiles to dig, paint rooms)
//   hold still (0.45 s) right click / held    (drop, slap, cancel)
//   two-finger tap      right click under the first finger
//   two-finger drag     scroll the dungeon view
//   pinch               zoom (mouse wheel steps at the fingers)
//   twist               rotate the view
// In creature possession a drag turns, a hold keeps attacking, and a stick on
// the left walks. The rail on the right of the game has the keys a touch
// screen lacks (menu, right-click mode, keyboard, and more).
//
// Controllers: the game reads them itself (SDL gamepad, as on the desktop);
// this file only says one was found and shows its layout.
'use strict';

const Touch = (() => {
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const canvas = $('canvas');
  const LONG_PRESS_MS = 450;
  const SLOP_PX = 10;            // movement that turns a tap into a drag
  const ZOOM_STEP = Math.log(1 / 0.85); // one wheel step zooms by 1/0.85 (engine_camera.c)
  const TWIST_START_DEG = 12;    // twist needed before the view starts turning

  const coarse = matchMedia('(pointer: coarse)');
  const noFinePointer = matchMedia('not (any-pointer: fine)');
  // A touch-first device (phone, tablet): the page says touch from the start.
  const touchFirst = () => coarse.matches && noFinePointer.matches && navigator.maxTouchPoints > 0;

  const game = (name) => (KFX.state === 'running' && typeof Module === 'object' && Module[`_kfx_web_${name}`]) || null;
  const call = (name, ...args) => { const f = game(name); if (f) f(...args); };

  // ---- Which input is in use --------------------------------------------------

  // body.input-touch / input-pad / input-mouse picks the hints and controls.
  let input = '';
  let more = null; // the rail's "more" panel, made below
  function useInput(kind) {
    if (kind === input) return;
    input = kind;
    for (const k of ['touch', 'pad', 'mouse']) document.body.classList.toggle(`input-${k}`, k === kind);
    if (kind !== 'touch') {
      call('touch_mode', 0);
      closeMore();
    }
  }
  window.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'touch' || ev.pointerType === 'pen') useInput('touch');
    else if (ev.pointerType === 'mouse') useInput('mouse');
  }, { capture: true });
  window.addEventListener('pointermove', (ev) => {
    // A real mouse moving over the game takes over from touch (and the pad).
    if (ev.pointerType === 'mouse' && (ev.movementX || ev.movementY) && input !== 'mouse' && ev.target === canvas) useInput('mouse');
  }, { capture: true });
  window.addEventListener('keydown', (ev) => { if (ev.isTrusted && input === 'pad') useInput('mouse'); }, { capture: true });

  // ---- Keys the touch rail sends ------------------------------------------------

  // SDL reads key events from the window; the game sees these as real keys.
  const KEYS = {
    Escape: 'Escape', Space: ' ', Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    ShiftLeft: 'Shift', ControlLeft: 'Control', Delete: 'Delete', PageDown: 'PageDown', Home: 'Home', End: 'End',
    KeyM: 'm', KeyP: 'p', KeyE: 'e',
  };
  function key(code, down) {
    if (KFX.state !== 'running') return;
    canvas.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
      key: KEYS[code] || code, code, bubbles: true, cancelable: true,
    }));
  }
  // Hold a key for ms and at least three of the game's frames, so the game
  // sees it down even when it draws slowly.
  function holdKey(code, ms = 120) {
    key(code, true);
    const start = performance.now();
    const until = (Module.kfxFrames || 0) + 3;
    const release = () => {
      if (performance.now() - start >= ms && (Module.kfxFrames || 0) >= until) key(code, false);
      else setTimeout(release, 16);
    };
    setTimeout(release, 16);
  }
  const tapKey = (code) => holdKey(code);
  function typeText(text) {
    for (const ch of text) {
      canvas.dispatchEvent(new KeyboardEvent('keypress', { key: ch, charCode: ch.codePointAt(0), bubbles: true, cancelable: true }));
    }
  }

  // ---- Fingers on the game ------------------------------------------------------

  // Normalised position on the canvas (0..1).
  function norm(x, y) {
    const r = canvas.getBoundingClientRect();
    return [(x - r.left) / r.width, (y - r.top) / r.height];
  }

  // The game finds the map tile under the cursor while it draws a frame, so
  // a press must wait until a frame or two has been drawn with the cursor
  // at the finger, and a release until the press was seen. Cursor moves and
  // button changes go through one queue, in order, with those gaps.
  const frames = () => Module.kfxFrames || 0;
  const queue = [];
  let readyAt = 0; // frame count before which no button may change
  let queued = false;
  function run() {
    queued = false;
    while (queue.length) {
      const op = queue[0];
      if (op.button !== undefined && frames() < readyAt) {
        queued = true;
        requestAnimationFrame(run);
        return;
      }
      queue.shift();
      if (op.point) {
        call('touch_point', ...op.point);
        readyAt = Math.max(readyAt, frames() + 2);
      } else if (op.button !== undefined) {
        call('touch_button', op.button, op.down);
        readyAt = frames() + 2;
      } else if (op.wheel !== undefined) {
        call('touch_wheel', op.wheel);
      }
    }
  }
  function push(op) {
    queue.push(op);
    if (!queued) run();
  }
  const point = (x, y) => push({ point: norm(x, y) });
  const button = (b, down) => push({ button: b, down: down ? 1 : 0 });
  function click(b) {
    button(b, true);
    button(b, false);
  }

  let context = 0; // kfx_web_input_context(): 1 level, 2 possession, 4 typing, 8 map, 16 menu
  const possessing = () => (context & 2) !== 0 && (context & 16) === 0;

  const fingers = new Map(); // pointerId -> {x, y, x0, y0, t0}
  let mode = 'idle'; // idle | pending | drag | hold | steer | fire | gesture | done
  let first = null;  // the finger that started it
  let pressTimer = 0;
  let gesture = null;
  let rightMode = false; // rail toggle: taps are right clicks

  function pair() {
    const [a, b] = [...fingers.values()];
    return {
      mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
      dist: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  function onDown(id, x, y, time) {
    fingers.set(id, { x, y, x0: x, y0: y, t0: time });
    if (fingers.size === 1) {
      first = fingers.get(id);
      call('touch_contact', 1);
      point(x, y);
      mode = 'pending';
      clearTimeout(pressTimer);
      // On a slow device the finger's first move can arrive a few frames
      // late: give a hold at least three frames.
      pressTimer = setTimeout(longPress, Math.max(possessing() ? 250 : LONG_PRESS_MS, 3 * frameMs));
    } else if (fingers.size === 2 && mode === 'pending') {
      clearTimeout(pressTimer);
      const p = pair();
      gesture = { ...p, t0: time, zoom: 0, twist: 0, twisting: false, moved: 0, used: false };
      mode = 'gesture';
    }
  }

  function longPress() {
    if (mode !== 'pending') return;
    if (possessing()) {
      mode = 'fire'; // keep attacking while held
      button(0, true);
      return;
    }
    mode = 'hold';
    button(1, true);
    if (navigator.vibrate) navigator.vibrate(15);
  }

  function onMove(id, x, y) {
    const f = fingers.get(id);
    if (!f) return;
    f.x = x;
    f.y = y;
    if (mode === 'pending' && Math.hypot(f.x - f.x0, f.y - f.y0) > SLOP_PX) {
      clearTimeout(pressTimer);
      if (possessing()) {
        mode = 'steer';
      } else {
        mode = 'drag';
        button(0, true); // pressed where the finger landed
      }
    }
    if (mode === 'drag' || mode === 'hold' || mode === 'steer' || mode === 'fire') {
      if (f === first) point(f.x, f.y);
    } else if (mode === 'gesture' && fingers.size === 2) {
      moveGesture();
    }
  }

  function moveGesture() {
    const p = pair();
    const g = gesture;
    const r = canvas.getBoundingClientRect();
    const dx = p.mx - g.mx;
    const dy = p.my - g.my;
    g.moved += Math.hypot(dx, dy);
    if (dx || dy) call('touch_pan', dx / r.width, dy / r.height);
    // Pinch: whole wheel steps at the middle of the fingers.
    if (g.dist > 0 && p.dist > 0) {
      g.zoom += Math.log(p.dist / g.dist) / ZOOM_STEP;
      while (Math.abs(g.zoom) >= 1) {
        point(p.mx, p.my);
        push({ wheel: g.zoom > 0 ? 1 : 0 });
        g.zoom -= Math.sign(g.zoom);
        g.used = true;
      }
    }
    // Twist: only after a clear turn, so pinching doesn't wobble the view.
    let da = (p.angle - g.angle) * 180 / Math.PI;
    if (da > 180) da -= 360;
    if (da < -180) da += 360;
    g.twist += da;
    if (!g.twisting && Math.abs(g.twist) > TWIST_START_DEG) { g.twisting = true; da = g.twist; }
    if (g.twisting && da) { call('touch_rotate', da); g.used = true; }
    Object.assign(g, { mx: p.mx, my: p.my, dist: p.dist, angle: p.angle });
  }

  function onUp(id, time, cancelled) {
    const f = fingers.get(id);
    if (!f) return;
    fingers.delete(id);
    if (mode === 'gesture') {
      // Both fingers down and up quickly without doing anything: right click.
      if (!cancelled && !gesture.used && gesture.moved < SLOP_PX * 2 && time - gesture.t0 < Math.max(400, 4 * frameMs)) {
        point(first.x0, first.y0);
        click(1);
      }
      mode = 'done';
    } else if (f === first) {
      if (mode === 'pending' && !cancelled) {
        // A tap.
        click(rightMode && !possessing() ? 1 : 0);
      } else if (mode === 'drag' || mode === 'fire') {
        button(0, false);
      } else if (mode === 'hold') {
        button(1, false);
      }
      if (mode !== 'idle') mode = 'done';
    }
    clearTimeout(pressTimer);
    if (!fingers.size) {
      mode = 'idle';
      first = null;
      gesture = null;
      call('touch_contact', 0);
    }
  }

  // Fingers are followed with touch events, which keep their coordinates even
  // while the page holds a pointer lock (pointer events then report none).
  // Preventing their default also stops scrolling, zooming, the emulated
  // mouse events and callouts.
  const touchHandlers = {
    touchstart: (t, time) => onDown(t.identifier, t.clientX, t.clientY, time),
    touchmove: (t) => onMove(t.identifier, t.clientX, t.clientY),
    touchend: (t, time) => onUp(t.identifier, time, false),
    touchcancel: (t, time) => onUp(t.identifier, time, true),
  };
  for (const [type, handle] of Object.entries(touchHandlers)) {
    stage.addEventListener(type, (ev) => {
      if (ev.target !== canvas) {
        if (ev.target.closest && ev.target.closest('.tstick') && ev.cancelable) ev.preventDefault();
        return;
      }
      if (ev.cancelable) ev.preventDefault();
      if (KFX.state !== 'running') return;
      useInput('touch');
      if (type === 'touchstart' && document.pointerLockElement) document.exitPointerLock();
      for (const t of ev.changedTouches) handle(t, ev.timeStamp);
    }, { capture: true, passive: false });
  }
  // SDL's own listeners on the canvas must not see the same fingers as
  // pointer events (capture on the stage runs before them).
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave']) {
    stage.addEventListener(type, (ev) => {
      if (ev.pointerType === 'touch' && ev.target === canvas) ev.stopPropagation();
    }, { capture: true });
  }
  stage.addEventListener('gesturestart', (ev) => ev.preventDefault()); // iOS Safari's own pinch
  stage.addEventListener('contextmenu', (ev) => { if (ev.target === canvas || ev.target.closest('.touch-ui')) ev.preventDefault(); });

  // ---- The rail of buttons ------------------------------------------------------

  const h = (tag, attrs = {}, kids = []) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of [].concat(kids)) el.append(kid);
    return el;
  };
  // Buttons act on pointerdown/click without taking focus, so the game keeps
  // the keyboard.
  const btn = (label, title, action, extra = {}) => h('button', {
    type: 'button', class: `tbtn ${extra.cls || ''}`, title, 'aria-label': title,
    onpointerdown: (ev) => ev.preventDefault(),
    onclick: (ev) => { ev.preventDefault(); action(ev.currentTarget); },
  }, extra.icon ? [h('b', {}, extra.icon), h('span', {}, label)] : [h('span', {}, label)]);

  const stickyKeys = new Set();
  function toggleSticky(code, el) {
    const on = !stickyKeys.has(code);
    if (on) stickyKeys.add(code); else stickyKeys.delete(code);
    key(code, on);
    el.classList.toggle('on', on);
  }
  function releaseSticky() {
    for (const code of stickyKeys) key(code, false);
    stickyKeys.clear();
    for (const el of rail.querySelectorAll('.tbtn.sticky.on')) el.classList.remove('on');
  }

  function setRightMode(on) {
    rightMode = on;
    $('t-right').classList.toggle('on', on);
  }

  more = h('div', { class: 'tmore', id: 't-more', hidden: '' }, [
    btn('Space', 'Space', () => tapKey('Space'), { icon: '␣' }),
    btn('Chat', 'Enter: chat and messages', () => tapKey('Enter'), { icon: '↵' }),
    btn('Map', 'Map (M)', () => tapKey('KeyM'), { icon: '▦' }),
    btn('Pause', 'Pause (P)', () => tapKey('KeyP'), { icon: '‖' }),
    btn('Shift', 'Shift, held until pressed again', (el) => toggleSticky('ShiftLeft', el), { icon: '⇧', cls: 'sticky' }),
    btn('Ctrl', 'Ctrl, held until pressed again', (el) => toggleSticky('ControlLeft', el), { icon: '⌃', cls: 'sticky' }),
    btn('Turn', 'Rotate the view left', () => holdKey('Delete', 300), { icon: '⟲' }),
    btn('Turn', 'Rotate the view right', () => holdKey('PageDown', 300), { icon: '⟳' }),
    btn('Zoom', 'Zoom in', () => holdKey('Home', 200), { icon: '+' }),
    btn('Zoom', 'Zoom out', () => holdKey('End', 200), { icon: '−' }),
    btn('Screen', 'Fullscreen or fill the tab', () => { closeMore(); fullscreen(); }, { icon: '⛶' }),
    btn('Hide', 'Hide these buttons (tap the tab at the edge to bring them back)', () => setRailHidden(true), { icon: '⇥' }),
  ]);
  const rail = h('div', { class: 'touch-ui trail', id: 'touch-rail' }, [
    btn('Menu', 'Game menu (Esc)', () => tapKey('Escape'), { icon: '≡' }),
    btn('Right', 'Right click: taps act as right clicks (drop, slap) until pressed again', () => setRightMode(!rightMode), { icon: '◐', cls: 'right' }),
    btn('Keys', 'Keyboard, for names and chat', () => openKeyboard(), { icon: '⌨', cls: 'kbd' }),
    btn('More', 'More keys', () => toggleMore(), { icon: '⋯', cls: 'moreb' }),
  ]);
  rail.querySelector('.right').id = 't-right';
  rail.querySelector('.kbd').id = 't-kbd';
  const railTab = h('button', { type: 'button', class: 'touch-ui ttab', id: 'touch-tab', title: 'Show the touch buttons', 'aria-label': 'Show the touch buttons',
    onpointerdown: (ev) => ev.preventDefault(), onclick: () => setRailHidden(false) }, '‹');

  function toggleMore() {
    const open = more.hidden;
    more.hidden = !open;
    rail.querySelector('.moreb').classList.toggle('on', open);
  }
  function closeMore() {
    if (more && !more.hidden) toggleMore();
  }
  function setRailHidden(hidden) {
    closeMore();
    document.body.classList.toggle('touch-rail-hidden', hidden);
    try { localStorage.setItem('kfx.touchRail', hidden ? 'hidden' : ''); } catch (e) { /* only for this visit */ }
  }
  try { if (localStorage.getItem('kfx.touchRail') === 'hidden') document.body.classList.add('touch-rail-hidden'); } catch (e) { /* shown */ }

  // Possession: a stick on the left walks (arrow keys) and a button leaves.
  const stick = h('div', { class: 'touch-ui tstick', id: 'touch-stick', 'aria-hidden': 'true' }, [h('i')]);
  const leave = btn('Leave', 'Leave the creature (right click)', () => click(1), { icon: '⏏', cls: 'tleave touch-ui' });
  leave.id = 'touch-leave';
  let stickId = null;
  const held = new Set();
  function stickTo(ev) {
    const r = stick.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = (ev.clientX - cx) / (r.width / 2);
    let dy = (ev.clientY - cy) / (r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    stick.firstChild.style.transform = `translate(${dx * 40}%, ${dy * 40}%)`;
    const want = new Set();
    if (dy < -0.35) want.add('ArrowUp');
    if (dy > 0.35) want.add('ArrowDown');
    if (dx < -0.35) want.add('ArrowLeft');
    if (dx > 0.35) want.add('ArrowRight');
    for (const k of held) if (!want.has(k)) { key(k, false); held.delete(k); }
    for (const k of want) if (!held.has(k)) { key(k, true); held.add(k); }
  }
  function stickEnd() {
    stickId = null;
    stick.firstChild.style.transform = '';
    for (const k of held) key(k, false);
    held.clear();
  }
  stick.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    stickId = ev.pointerId;
    stick.setPointerCapture(ev.pointerId);
    stickTo(ev);
  });
  stick.addEventListener('pointermove', (ev) => { if (ev.pointerId === stickId) stickTo(ev); });
  stick.addEventListener('pointerup', (ev) => { if (ev.pointerId === stickId) stickEnd(); });
  stick.addEventListener('pointercancel', (ev) => { if (ev.pointerId === stickId) stickEnd(); });

  // ---- On-screen keyboard -------------------------------------------------------

  // The game has no text field of its own for the phone's keyboard to type
  // into, so a hidden one stands in. It keeps one space so Backspace on an
  // "empty" field still arrives; whatever else appears is sent as typed text.
  const SENTINEL = ' ';
  const field = h('input', {
    class: 'tfield', id: 'touch-field', type: 'text', autocomplete: 'off', autocorrect: 'off',
    autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'done', 'aria-label': 'Text for the game',
  });
  field.value = SENTINEL;
  field.addEventListener('input', () => {
    const v = field.value;
    if (v.length < SENTINEL.length || !v.startsWith(SENTINEL)) tapKey('Backspace');
    else if (v.length > SENTINEL.length) typeText(v.slice(SENTINEL.length));
    field.value = SENTINEL;
    field.setSelectionRange(1, 1);
  });
  // Keys typed into the field go to the game only through the code above
  // (Enter, Backspace and Escape as keys); SDL doesn't see them twice.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    field.addEventListener(type, (ev) => {
      ev.stopPropagation();
      if (['Enter', 'Escape', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) {
        ev.preventDefault();
        if (type !== 'keypress') key(ev.code || ev.key, type === 'keydown');
        if (type === 'keydown' && (ev.key === 'Enter' || ev.key === 'Escape')) setTimeout(closeKeyboard, 50);
      } else if (ev.key === 'Backspace' && type === 'keydown' && field.value === SENTINEL) {
        ev.preventDefault();
        tapKey('Backspace');
      }
    });
  }
  function openKeyboard() {
    field.value = SENTINEL;
    field.focus({ preventScroll: true });
    field.setSelectionRange(1, 1);
    document.body.classList.add('touch-typing');
  }
  function closeKeyboard() {
    document.body.classList.remove('touch-typing');
    if (document.activeElement === field) field.blur();
  }
  field.addEventListener('blur', () => document.body.classList.remove('touch-typing'));

  // ---- Following the game --------------------------------------------------------

  // What the game is doing decides the controls: the walking stick in
  // possession, the keyboard when a text field is waiting.
  let polling = false;
  let frameMs = 16;
  let lastFrames = 0;
  let lastFrameTime = 0;
  function poll() {
    const now = performance.now();
    const frames = Module.kfxFrames || 0;
    if (lastFrameTime && frames > lastFrames) frameMs = 0.7 * frameMs + 0.3 * (now - lastFrameTime) / (frames - lastFrames);
    lastFrames = frames;
    lastFrameTime = now;
    const f = game('input_context');
    const next = f ? f() : 0;
    if (next !== context) {
      const was = context;
      context = next;
      document.body.classList.toggle('game-level', (next & 1) !== 0);
      document.body.classList.toggle('game-possess', (next & 2) !== 0);
      document.body.classList.toggle('game-typing', (next & 4) !== 0);
      if ((was & 2) && !(next & 2)) stickEnd();
      if (!(was & 4) && (next & 4) && input === 'touch') openKeyboard(); // may need the Keys button on iOS
      if ((was & 4) && !(next & 4)) closeKeyboard();
      if (!(next & 1)) releaseSticky();
    }
    setTimeout(poll, 150);
  }
  document.addEventListener('kfx:state', (ev) => {
    if (ev.detail === 'running' && !polling) { polling = true; poll(); }
    if (ev.detail !== 'running') { releaseSticky(); stickEnd(); closeKeyboard(); }
  });

  // ---- Fullscreen on phones -------------------------------------------------------

  // iPhone Safari has no fullscreen for page elements: fill the tab instead.
  // Where fullscreen works, also ask for landscape (Android).
  function fullscreen() {
    if (!stage.requestFullscreen && !stage.webkitRequestFullscreen) {
      $('btn-theater').click();
      return;
    }
    $('btn-fullscreen').click();
  }
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement && input === 'touch' && screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(() => {});
    }
  });

  // ---- Controllers ---------------------------------------------------------------

  const padNames = new Map();
  window.addEventListener('gamepadconnected', (ev) => {
    const name = (ev.gamepad.id || 'Controller').replace(/\s*\(.*\)\s*$/, '') || 'Controller';
    padNames.set(ev.gamepad.index, name);
    document.body.classList.add('has-pad');
    useInput('pad');
    if (typeof Site === 'object' && Site.toast) {
      Site.toast([h('b', {}, `${name} connected. `), 'Right stick moves the hand, RT clicks, LT drops and slaps. ',
        h('a', { href: '#/guide' }, 'All buttons')], { stage: true, ms: 7000 });
    }
  });
  window.addEventListener('gamepaddisconnected', (ev) => {
    padNames.delete(ev.gamepad.index);
    if (!padNames.size) {
      document.body.classList.remove('has-pad');
      if (input === 'pad') useInput(touchFirst() ? 'touch' : 'mouse');
    }
  });
  // The page only learns about a pad from a button press; after that, any
  // pad input counts as using it.
  let padSeen = 0;
  function padWatch() {
    if (padNames.size && input !== 'pad' && navigator.getGamepads) {
      for (const p of navigator.getGamepads()) {
        if (!p) continue;
        const active = p.buttons.some((b) => b.pressed) || p.axes.some((a) => Math.abs(a) > 0.5);
        if (active && p.timestamp !== padSeen) { padSeen = p.timestamp; useInput('pad'); }
      }
    }
    setTimeout(padWatch, 250);
  }
  padWatch();

  useInput(touchFirst() ? 'touch' : 'mouse');
  stage.append(rail, more, railTab, stick, leave, field);
  return { useInput, get input() { return input; }, openKeyboard };
})();
