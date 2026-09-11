// dsh-surface — DSH event envelope builder (pure, zero imports).
// Maps a normalized `{ type, turn, step, message, reason, stream? }` into a DSH
// `SessionEvent`-shaped `{ type, data, surfaceOp? }`. Host (`lib/index.js`) adds
// `seq`/`time`; the pure core (`lib/surface-seed.js`) drives the structure.
//
// v3 note: `assistant/message` is a SETTLEMENT event — session format v3 requires
// `data.stream` to be an array (dsh-session `assertAssistantSettlementShape`).
// Omitting it makes Session construction reject the whole seed with
// "seed assistant/message at index N has invalid settlement fields".
export function makeEvent(partial) {
  const { type, turn, step, message, reason, stream, usage, interrupted } = partial
  let data
  let surfaceOp
  switch (type) {
    case 'turn/start': data = { turn }; break
    case 'turn/end': data = { turn, reason }; break
    case 'step/start':
    case 'step/end': data = { turn, step }; break
    case 'user/message': data = message; surfaceOp = 'append'; break
    case 'assistant/message':
      data = {
        turn,
        step,
        message,
        stream: Array.isArray(stream) ? stream : [],
        ...(usage === undefined ? {} : { usage }),
        ...(interrupted === undefined ? {} : { interrupted }),
      }
      surfaceOp = 'append'
      break
    case 'tool/result': data = { turn, step, message }; surfaceOp = 'append'; break
    default: throw new Error(`dsh-surface: unsupported event type "${type}"`)
  }
  return { type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) }
}
