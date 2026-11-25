// Source: wangzan101/Mika @ e8479330f7284dd0031649636e18e197d6633ece (Apache-2.0; Copyright 2026 wangzan101).
// K2 extraction only: see slice-map.json for upstream path, inclusive ranges and digests.
// This file is embedded in a local closure; it has no I/O or execution authority.
const tones = {
  starting: "active",
  queued: "active",
  running: "active",
  paused: "",
  waiting_for_answer: "attention",
  waiting_on_phone: "attention",
  done: "",
  failed: "bad",
  cancelled: ""
};
const terminal = new Set(["done", "failed", "cancelled"]);

const isActive = task => !terminal.has(task.status);
const urgency = task => (tones[task.status] === "attention" ? 0 : isActive(task) ? 1 : 2);
const threadOf = task => (task.conversation ? "chat:" + task.conversation : "task:" + task.task_id);

function groupTasks(tasks) {
  const threads = new Map();
  // API order is newest first (including ties); show turns oldest first inside each conversation.
  for (const task of tasks) {
    const key = threadOf(task);
    if (!threads.has(key)) threads.set(key, { key, turns: [], primary: task });
    const group = threads.get(key);
    group.turns.push(task);
    if (urgency(task) < urgency(group.primary)) group.primary = task;
  }
  const ordered = [...threads.values()].sort((a, b) => urgency(a.primary) - urgency(b.primary));
  for (const thread of ordered) thread.turns.reverse();
  return ordered;
}
