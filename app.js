"use strict";

const COLS = 10;
const ROWS = 20;
const BOARD_PTR = 0;
const SHAPE_PTR = 256;
const CELL = 30;
const COLORS = [
  "#0a0d10",
  "#31c3bd",
  "#ffd166",
  "#7d5fff",
  "#ff6b6b",
  "#4d96ff",
  "#f72585",
  "#80ed99",
];

const PIECES = [
  { color: 1, cells: [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
  { color: 2, cells: [0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { color: 3, cells: [0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { color: 4, cells: [1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { color: 5, cells: [0, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { color: 6, cells: [1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { color: 7, cells: [0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
];

const $ = (id) => document.getElementById(id);
const boardCanvas = $("board");
const nextCanvas = $("next");
const ctx = boardCanvas.getContext("2d");
const nextCtx = nextCanvas.getContext("2d");
const overlay = $("overlay");
const scoreEl = $("score");
const linesEl = $("lines");
const levelEl = $("level");
const wasmState = $("wasmState");

let wasm = null;
let memory = null;
let board = new Uint8Array(COLS * ROWS);
let current = null;
let nextPiece = null;
let score = 0;
let lines = 0;
let level = 1;
let running = false;
let gameOver = false;
let lastTime = 0;
let dropCounter = 0;

function encodeU32(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function encodeI32(n) {
  const out = [];
  let more = true;
  while (more) {
    let b = n & 0x7f;
    n >>= 7;
    const sign = (b & 0x40) !== 0;
    if ((n === 0 && !sign) || (n === -1 && sign)) more = false;
    else b |= 0x80;
    out.push(b);
  }
  return out;
}

function makeWasmBytes() {
  const op = {
    end: 0x0b, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, br: 0x0c, brIf: 0x0d,
    ret: 0x0f, get: 0x20, set: 0x21, load8: 0x2d, store8: 0x3a, c: 0x41, eqz: 0x45,
    ne: 0x47, ltS: 0x48, geS: 0x4e, geU: 0x4f, add: 0x6a, mul: 0x6c, divU: 0x6e,
    remU: 0x70, or: 0x72,
  };
  const str = (s) => [...encodeU32(s.length), ...new TextEncoder().encode(s)];
  const sec = (id, data) => [id, ...encodeU32(data.length), ...data];
  const I = {
    c: (n) => [op.c, ...encodeI32(n)],
    g: (n) => [op.get, ...encodeU32(n)],
    s: (n) => [op.set, ...encodeU32(n)],
    load: () => [op.load8, 0, 0],
    store: () => [op.store8, 0, 0],
  };
  const addr = (boardLocal, yLocal, xLocal) => [
    ...I.g(boardLocal), ...I.g(yLocal), ...I.c(10), op.mul, ...I.g(xLocal), op.add, op.add,
  ];
  const shapeLoad = (shapeLocal, iLocal) => [...I.g(shapeLocal), ...I.g(iLocal), op.add, ...I.load()];
  const fn = (localCount, code) => {
    const locals = localCount ? [...encodeU32(1), ...encodeU32(localCount), 0x7f] : [0];
    const body = [...locals, ...code, op.end];
    return [...encodeU32(body.length), ...body];
  };

  const canPlace = () => {
    const b = [];
    b.push(...I.c(0), ...I.s(4), op.block, 0x40, op.loop, 0x40);
    b.push(...I.g(4), ...I.c(16), op.geU, op.brIf, ...encodeU32(1));
    b.push(...shapeLoad(1, 4), op.eqz, op.if, 0x40, op.else);
    b.push(...I.g(4), ...I.c(4), op.remU, ...I.s(5), ...I.g(4), ...I.c(4), op.divU, ...I.s(6));
    b.push(...I.g(2), ...I.g(5), op.add, ...I.s(7), ...I.g(3), ...I.g(6), op.add, ...I.s(8));
    b.push(...I.g(7), ...I.c(0), op.ltS, ...I.g(7), ...I.c(10), op.geS, op.or, ...I.g(8), ...I.c(20), op.geS, op.or);
    b.push(op.if, 0x40, ...I.c(0), op.ret, op.end);
    b.push(...I.g(8), ...I.c(0), op.geS, op.if, 0x40);
    b.push(...addr(0, 8, 7), ...I.load(), op.eqz, op.if, 0x40, op.else, ...I.c(0), op.ret, op.end);
    b.push(op.end, op.end, ...I.g(4), ...I.c(1), op.add, ...I.s(4), op.br, ...encodeU32(0));
    b.push(op.end, op.end, ...I.c(1), op.ret);
    return fn(5, b);
  };

  const place = () => {
    const b = [];
    b.push(...I.c(0), ...I.s(5), op.block, 0x40, op.loop, 0x40);
    b.push(...I.g(5), ...I.c(16), op.geU, op.brIf, ...encodeU32(1));
    b.push(...shapeLoad(1, 5), op.eqz, op.if, 0x40, op.else);
    b.push(...I.g(5), ...I.c(4), op.remU, ...I.s(6), ...I.g(5), ...I.c(4), op.divU, ...I.s(7));
    b.push(...I.g(2), ...I.g(6), op.add, ...I.s(8), ...I.g(3), ...I.g(7), op.add, ...I.s(9));
    b.push(...I.g(9), ...I.c(0), op.geS, op.if, 0x40, ...addr(0, 9, 8), ...I.g(4), ...I.store(), op.end);
    b.push(op.end, ...I.g(5), ...I.c(1), op.add, ...I.s(5), op.br, ...encodeU32(0), op.end, op.end);
    return fn(5, b);
  };

  const bytes = [0, 97, 115, 109, 1, 0, 0, 0];
  bytes.push(...sec(1, [
    ...encodeU32(2),
    0x60, ...encodeU32(4), 0x7f, 0x7f, 0x7f, 0x7f, ...encodeU32(1), 0x7f,
    0x60, ...encodeU32(5), 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, ...encodeU32(0),
  ]));
  bytes.push(...sec(3, [...encodeU32(2), ...encodeU32(0), ...encodeU32(1)]));
  bytes.push(...sec(5, [...encodeU32(1), 0x00, ...encodeU32(1)]));
  bytes.push(...sec(7, [
    ...encodeU32(3),
    ...str("memory"), 0x02, ...encodeU32(0),
    ...str("canPlace"), 0x00, ...encodeU32(0),
    ...str("place"), 0x00, ...encodeU32(1),
  ]));
  bytes.push(...sec(10, [...encodeU32(2), ...canPlace(), ...place()]));
  return new Uint8Array(bytes);
}

async function initWasm() {
  try {
    const module = await WebAssembly.instantiate(makeWasmBytes());
    wasm = module.instance.exports;
    memory = new Uint8Array(wasm.memory.buffer);
    wasmState.textContent = "WASM active";
  } catch (error) {
    wasmState.textContent = "JS fallback";
    wasmState.classList.add("fallback");
    console.warn("WASM unavailable:", error);
  }
}

function clonePiece(piece) {
  return { color: piece.color, cells: piece.cells.slice(), x: 3, y: -1 };
}

function randomPiece() {
  return clonePiece(PIECES[Math.floor(Math.random() * PIECES.length)]);
}

function writeMemory() {
  if (!memory) return;
  memory.set(board, BOARD_PTR);
  memory.set(current.cells, SHAPE_PTR);
}

function canPlace(piece, x = piece.x, y = piece.y, cells = piece.cells) {
  if (wasm && memory) {
    memory.set(board, BOARD_PTR);
    memory.set(cells, SHAPE_PTR);
    return wasm.canPlace(BOARD_PTR, SHAPE_PTR, x, y) === 1;
  }
  for (let i = 0; i < 16; i += 1) {
    if (!cells[i]) continue;
    const bx = x + (i % 4);
    const by = y + Math.floor(i / 4);
    if (bx < 0 || bx >= COLS || by >= ROWS) return false;
    if (by >= 0 && board[by * COLS + bx]) return false;
  }
  return true;
}

function placePiece() {
  if (wasm && memory) {
    writeMemory();
    wasm.place(BOARD_PTR, SHAPE_PTR, current.x, current.y, current.color);
    board.set(memory.slice(BOARD_PTR, BOARD_PTR + COLS * ROWS));
  } else {
    current.cells.forEach((cell, i) => {
      if (!cell) return;
      const x = current.x + (i % 4);
      const y = current.y + Math.floor(i / 4);
      if (y >= 0) board[y * COLS + x] = current.color;
    });
  }
}

function rotateCells(cells) {
  const out = new Array(16).fill(0);
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) out[x * 4 + (3 - y)] = cells[y * 4 + x];
  }
  return out;
}

function rotate() {
  const rotated = rotateCells(current.cells);
  const kicks = [0, -1, 1, -2, 2];
  for (const kick of kicks) {
    if (canPlace(current, current.x + kick, current.y, rotated)) {
      current.cells = rotated;
      current.x += kick;
      return;
    }
  }
}

function sweepLines() {
  let cleared = 0;
  for (let y = ROWS - 1; y >= 0; y -= 1) {
    let full = true;
    for (let x = 0; x < COLS; x += 1) {
      if (!board[y * COLS + x]) {
        full = false;
        break;
      }
    }
    if (!full) continue;
    cleared += 1;
    for (let row = y; row > 0; row -= 1) {
      board.copyWithin(row * COLS, (row - 1) * COLS, row * COLS);
    }
    board.fill(0, 0, COLS);
    y += 1;
  }
  if (cleared) {
    lines += cleared;
    score += [0, 100, 300, 500, 800][cleared] * level;
    level = Math.floor(lines / 10) + 1;
    updateStats();
  }
}

function spawn() {
  current = nextPiece || randomPiece();
  nextPiece = randomPiece();
  if (!canPlace(current)) {
    running = false;
    gameOver = true;
    overlay.querySelector("strong").textContent = "GAME OVER";
    overlay.querySelector("span").textContent = "Tap to retry";
    overlay.classList.remove("hidden");
  }
}

function move(dx) {
  if (canPlace(current, current.x + dx, current.y)) current.x += dx;
}

function softDrop() {
  if (canPlace(current, current.x, current.y + 1)) {
    current.y += 1;
    score += 1;
    updateStats();
  } else {
    placePiece();
    sweepLines();
    spawn();
  }
}

function hardDrop() {
  while (canPlace(current, current.x, current.y + 1)) {
    current.y += 1;
    score += 2;
  }
  softDrop();
}

function updateStats() {
  scoreEl.textContent = score.toString();
  linesEl.textContent = lines.toString();
  levelEl.textContent = level.toString();
}

function drawCell(target, x, y, color, size) {
  target.fillStyle = COLORS[color];
  target.fillRect(x * size + 1, y * size + 1, size - 2, size - 2);
  target.fillStyle = "rgba(255,255,255,0.14)";
  target.fillRect(x * size + 1, y * size + 1, size - 2, 4);
}

function draw() {
  ctx.fillStyle = "#0a0d10";
  ctx.fillRect(0, 0, boardCanvas.width, boardCanvas.height);
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  for (let x = 1; x < COLS; x += 1) {
    ctx.beginPath();
    ctx.moveTo(x * CELL, 0);
    ctx.lineTo(x * CELL, ROWS * CELL);
    ctx.stroke();
  }
  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLS; x += 1) {
      const color = board[y * COLS + x];
      if (color) drawCell(ctx, x, y, color, CELL);
    }
  }
  if (current) {
    current.cells.forEach((cell, i) => {
      if (!cell) return;
      const x = current.x + (i % 4);
      const y = current.y + Math.floor(i / 4);
      if (y >= 0) drawCell(ctx, x, y, current.color, CELL);
    });
  }
  drawNext();
}

function drawNext() {
  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  nextCtx.fillStyle = "#0a0d10";
  nextCtx.fillRect(0, 0, nextCanvas.width, nextCanvas.height);
  if (!nextPiece) return;
  nextPiece.cells.forEach((cell, i) => {
    if (!cell) return;
    drawCell(nextCtx, (i % 4) + 0.5, Math.floor(i / 4) + 0.5, nextPiece.color, 24);
  });
}

function reset() {
  board.fill(0);
  score = 0;
  lines = 0;
  level = 1;
  gameOver = false;
  nextPiece = randomPiece();
  spawn();
  updateStats();
}

function start() {
  if (gameOver || !current) reset();
  running = true;
  overlay.classList.add("hidden");
}

function update(time = 0) {
  const delta = time - lastTime;
  lastTime = time;
  if (running) {
    dropCounter += delta;
    const interval = Math.max(110, 820 - (level - 1) * 62);
    if (dropCounter > interval) {
      softDrop();
      dropCounter = 0;
    }
  }
  draw();
  requestAnimationFrame(update);
}

function handleAction(action) {
  if (!running) start();
  if (!running) return;
  if (action === "left") move(-1);
  if (action === "right") move(1);
  if (action === "rotate") rotate();
  if (action === "down") softDrop();
  if (action === "drop") hardDrop();
  draw();
}

document.addEventListener("keydown", (event) => {
  const keys = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "rotate",
    ArrowDown: "down",
    " ": "drop",
  };
  if (keys[event.key]) {
    event.preventDefault();
    handleAction(keys[event.key]);
  }
});

document.querySelectorAll("button[data-action]").forEach((button) => {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handleAction(button.dataset.action);
  });
});

overlay.addEventListener("pointerdown", start);
boardCanvas.addEventListener("pointerdown", start);

initWasm().then(() => {
  reset();
  update();
});
