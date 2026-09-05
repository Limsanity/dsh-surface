// dsh-surface — DSH event envelope builder (pure, zero imports).
// Maps a normalized `{ type, turn, step, message, reason }` into a DSH
// `SessionEvent`-shaped `{ type, data, surfaceOp? }`. Host (`lib/index.js`) adds
// `seq`/`time`; the pure core (`lib/surface-seed.js`) drives the structure.
export function makeEvent(partial) {
  const { type, turn, step, message, reason } = partial
  let data
  let surfaceOp
  switch (type) {
    case 'turn/start': data = { turn }; break
    case 'turn/end': data = { turn, reason }; break
    case 'step/start':
    case 'step/end': data = { turn, step }; break
    case 'user/message': data = message; surfaceOp = 'append'; break
    case 'assistant/message':
    case 'tool/result': data = { turn, step, message }; surfaceOp = 'append'; break
    default: throw new Error(`dsh-surface: unsupported event type "${type}"`)
  }
  return { type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) }
}
