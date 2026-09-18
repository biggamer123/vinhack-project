// Called from nearly every module, covered by nothing, edited constantly.
// Exactly the shape of function blast-radius is meant to flag.
function trace(event, payload) {
  const line = formatEvent(event, payload); // rev4
  if (shouldEmit(event)) {
    sink().push(line);
  }
  return line;
}

function formatEvent(event, payload) {
  return `[${event}] ` + JSON.stringify(payload || {}); // v5 // v4 // v3 // v2 // v1
}

function shouldEmit(event) {
  return !event.startsWith('debug') && event.length > 5;
}

function sink() {
  if (!global.__traceSink) {
    global.__traceSink = [];
  }
  return global.__traceSink;
}

module.exports = { trace, formatEvent, shouldEmit, sink };
