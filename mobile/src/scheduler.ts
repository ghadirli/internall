/**
 * Scheduled tasks on mobile.
 *
 * A phone will not let an app run an LLM turn in the background, so this uses
 * local notifications as the alarm: the OS fires at the right moment, and the
 * work runs when the app is in the foreground — immediately if it is already
 * open, otherwise the moment you open it (with a grace window so a stale
 * briefing does not turn up hours late).
 */
import * as Notifications from 'expo-notifications';
import { store, newId } from './store';
import { Task, TaskKind } from './types';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const GRACE_MS = 6 * 60 * 60 * 1000;
const IN_GRACE_MS = 30 * 60 * 1000;

export const isOneShot = (kind: TaskKind) => kind === 'once' || kind === 'in';

function parseHM(time: string, fallback = '08:00') {
  const m = /^(\d{1,2}):(\d{2})$/.exec((time || '').trim()) || /^(\d{1,2}):(\d{2})$/.exec(fallback)!;
  return { h: Math.min(23, Number(m[1])), min: Math.min(59, Number(m[2])) };
}

export function computeNext(task: Task, from = Date.now()): number {
  if (task.kind === 'in') return from + Math.max(1, task.inMinutes || 1) * 60000;
  if (task.kind === 'interval') return from + Math.max(15, task.everyMinutes || 60) * 60000;

  const { h, min } = parseHM(task.time);
  if (task.kind === 'once') {
    const d = task.date ? new Date(`${task.date}T00:00:00`) : new Date(from);
    d.setHours(h, min, 0, 0);
    if (!task.date && d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  const d = new Date(from);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  if (task.kind === 'weekdays') {
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  } else if (task.kind === 'weekly') {
    const want = ((task.weekday % 7) + 7) % 7;
    while (d.getDay() !== want) d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

export function taskLabel(task: Task) {
  if (task.kind === 'in') {
    const n = Math.max(1, task.inMinutes || 1);
    const at = task.nextRun
      ? new Date(task.nextRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : null;
    return at ? `once at ${at} (${n} min after it was set)` : `once, in ${n} minutes`;
  }
  if (task.kind === 'interval') return `every ${Math.max(15, task.everyMinutes || 60)} minutes`;
  if (task.kind === 'daily') return `every day at ${task.time}`;
  if (task.kind === 'weekdays') return `weekdays at ${task.time}`;
  if (task.kind === 'weekly') return `every ${WEEKDAYS[((task.weekday % 7) + 7) % 7]} at ${task.time}`;
  return task.date ? `once on ${task.date} at ${task.time}` : `once at ${task.time}`;
}

export async function ensurePermission() {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') {
      const asked = await Notifications.requestPermissionsAsync();
      return asked.status === 'granted';
    }
    return true;
  } catch {
    return false;
  }
}

async function scheduleNotification(task: Task) {
  if (!task.nextRun || !task.enabled) return null;
  const agent = store.agent(task.agentId);
  try {
    await ensurePermission();
    return await Notifications.scheduleNotificationAsync({
      content: {
        title: agent ? `${agent.name} · scheduled` : 'Scheduled task',
        body: task.instruction.slice(0, 120),
        data: { taskId: task.id, agentId: task.agentId },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(task.nextRun) },
    });
  } catch (e) {
    console.warn('notification scheduling failed', e);
    return null;
  }
}

async function cancelNotification(task: Task) {
  if (!task.notificationId) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(task.notificationId);
  } catch {}
  task.notificationId = null;
}

export async function addTask(input: {
  agentId: string;
  instruction: string;
  kind: TaskKind;
  time?: string;
  date?: string;
  weekday?: number;
  everyMinutes?: number;
  inMinutes?: number;
}): Promise<Task> {
  const task: Task = {
    id: newId(),
    agentId: input.agentId,
    instruction: input.instruction,
    kind: input.kind,
    time: /^\d{1,2}:\d{2}$/.test(input.time || '') ? input.time! : '08:00',
    date: /^\d{4}-\d{2}-\d{2}$/.test(input.date || '') ? input.date! : '',
    weekday: Number(input.weekday ?? -1),
    everyMinutes: Number(input.everyMinutes ?? 0),
    inMinutes: Number(input.inMinutes ?? 0),
    enabled: true,
    createdAt: Date.now(),
    lastRun: null,
    nextRun: null,
  };
  task.nextRun = computeNext(task);
  task.notificationId = await scheduleNotification(task);
  store.set({ tasks: [...store.state.tasks, task] });
  return task;
}

export async function cancelTask(id: string) {
  const task = store.state.tasks.find((t) => t.id === id);
  if (task) await cancelNotification(task);
  store.set({ tasks: store.state.tasks.filter((t) => t.id !== id) });
  return Boolean(task);
}

export async function toggleTask(id: string) {
  const task = store.state.tasks.find((t) => t.id === id);
  if (!task) return;
  task.enabled = !task.enabled;
  if (task.enabled) {
    task.nextRun = computeNext(task);
    task.notificationId = await scheduleNotification(task);
  } else {
    await cancelNotification(task);
    task.nextRun = null;
  }
  store.set({ tasks: [...store.state.tasks] });
}

export const tasksFor = (agentId: string) => store.state.tasks.filter((t) => t.agentId === agentId);

/**
 * Runs whatever is due. Called on launch, on foreground, and on a timer while
 * the app is open. `deliver` hands the instruction to the agent runtime.
 */
export async function runDueTasks(deliver: (agentId: string, text: string) => Promise<void> | void) {
  const now = Date.now();
  let changed = false;

  for (const t of store.state.tasks) {
    if (!t.enabled || !t.nextRun || t.nextRun > now) continue;

    const grace = t.kind === 'in' ? IN_GRACE_MS : GRACE_MS;
    const tooLate = now - t.nextRun > grace || t.kind === 'interval';
    const agent = store.agent(t.agentId);

    if (!agent) continue;
    if (store.isRunning(agent.id)) continue; // that chat is mid-reply — next pass

    const label = taskLabel(t);
    changed = true;

    if (tooLate) {
      t.nextRun = isOneShot(t.kind) ? null : computeNext(t, now);
      if (!t.nextRun) t.enabled = false;
      else t.notificationId = await scheduleNotification(t);
      continue; // skip the stale run, keep the schedule alive
    }

    t.lastRun = now;
    if (isOneShot(t.kind)) {
      t.enabled = false;
      t.nextRun = null;
    } else {
      t.nextRun = computeNext(t, now);
      t.notificationId = await scheduleNotification(t);
    }

    await deliver(agent.id, `⏰ Scheduled task (${label}):\n${t.instruction}`);
  }

  if (changed) store.set({ tasks: [...store.state.tasks] });
}

/** Re-arms OS notifications after a restart, since they live outside our store. */
export async function rearmNotifications() {
  for (const t of store.state.tasks) {
    if (!t.enabled) continue;
    if (!t.nextRun || t.nextRun < Date.now()) continue;
    if (t.notificationId) continue;
    t.notificationId = await scheduleNotification(t);
  }
  store.set({ tasks: [...store.state.tasks] }, true);
}
