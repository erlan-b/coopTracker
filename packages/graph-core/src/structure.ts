// Структура зависимостей: циклы, порядок обхода и то, что идёт «после» задачи или ноды.
// Обходы идут по указателям рабочей копии (draft.ts) и смотрят только на соседей.

import { rememberOrder } from './draft';
import type { GraphDraft } from './draft';
import { asNodeId } from './ids';
import type { NodeId, TaskId } from './ids';
import type { GraphEdge, GraphNode } from './types';

// ---- Граф зависимостей ----

/**
 * Граф зависимостей. Вершина — нода, но роадмапа R — две вершины:
 * «начало R» (в него входят стрелки к R, из него — путь к каждой ноде внутри)
 * и «конец R» (в него — от каждой ноды внутри, из него — стрелки от R).
 * Так тупик через границу роадмапы становится обычным циклом.
 * Стрелка от задачи идёт от вершины её блока.
 */
type Vertex = string;

const startOf = (node: GraphNode): Vertex =>
  node.type === 'roadmap' ? `s:${node.id}` : `n:${node.id}`;
const endOf = (node: GraphNode): Vertex =>
  node.type === 'roadmap' ? `e:${node.id}` : `n:${node.id}`;
const nodeIdOf = (vertex: Vertex): NodeId => asNodeId(vertex.slice(2));

/**
 * Куда ведут зависимости из вершины. sorted — по порядку вершин, а не как лежат в памяти: так
 * путь цикла в ошибке у сервера и клиента одинаковый. Для проверки «есть ли путь» не нужно.
 */
function successors(view: GraphDraft, vertex: Vertex, sorted: boolean): Vertex[] {
  const id = nodeIdOf(vertex);
  const node = view.node(id);
  if (!node) return [];
  const result: Vertex[] = [];
  if (vertex.startsWith('s:')) {
    // Пустая роадмапа пропускает зависимость насквозь: X → R → Y — это всё ещё X → Y.
    result.push(endOf(node));
    for (const childId of view.childrenOf(id)) {
      const child = view.node(childId);
      if (child) result.push(startOf(child));
    }
    return sorted ? result.sort() : result;
  }
  for (const edgeId of view.edgesOut(id)) {
    const edge = view.edge(edgeId);
    const target = edge && view.node(edge.target.nodeId);
    if (target) result.push(startOf(target));
  }
  const parent = node.parentId === null ? undefined : view.node(node.parentId);
  if (parent?.type === 'roadmap') result.push(endOf(parent));
  return sorted ? result.sort() : result;
}

function verticesOf(view: GraphDraft): Vertex[] {
  const vertices: Vertex[] = [];
  for (const node of view.nodes.values()) {
    vertices.push(startOf(node));
    if (node.type === 'roadmap') vertices.push(endOf(node));
  }
  return vertices;
}

/** Ноды пути без повторов (у роадмапы две вершины). */
const pathNodes = (path: readonly Vertex[]): NodeId[] => [...new Set(path.map(nodeIdOf))];

// ---- Циклы ----

/**
 * Обход в глубину из вершин roots. Возвращает путь до первой вершины, для которой stop даёт
 * true, или null. Без рекурсии, чтобы длинная цепочка не переполнила стек.
 */
function searchFrom(
  view: GraphDraft,
  sorted: boolean,
  roots: Iterable<Vertex>,
  stop: (vertex: Vertex, onPath: ReadonlyMap<Vertex, number>) => boolean,
): { readonly path: Vertex[]; readonly next: Vertex } | null {
  const finished = new Set<Vertex>();
  const depthOnPath = new Map<Vertex, number>();
  for (const root of roots) {
    if (finished.has(root)) continue;
    const path: Vertex[] = [root];
    const pending: Vertex[][] = [successors(view, root, sorted)];
    depthOnPath.set(root, 0);
    while (path.length > 0) {
      const next = pending[pending.length - 1]!.pop();
      if (next === undefined) {
        const done = path.pop()!;
        pending.pop();
        finished.add(done);
        depthOnPath.delete(done);
        continue;
      }
      if (stop(next, depthOnPath)) return { path, next };
      if (finished.has(next) || depthOnPath.has(next)) continue;
      depthOnPath.set(next, path.length);
      path.push(next);
      pending.push(successors(view, next, sorted));
    }
  }
  return null;
}

/**
 * Первый найденный цикл или тупик во всём графе: ноды в порядке обхода, без повторов (для
 * подсветки). null — циклов нет. Есть ли цикл, быстрее узнать через hasCycle; одну новую
 * стрелку проверяет edgeCycle.
 */
export function findCycle(view: GraphDraft): NodeId[] | null {
  const found = searchFrom(view, true, verticesOf(view).sort(), (next, onPath) => onPath.has(next));
  if (!found) return null;
  return pathNodes(found.path.slice(found.path.indexOf(found.next)));
}

/** Цикл, который замкнёт стрелка: ноды по порядку и переходы между вершинами. */
export type CyclePath = {
  /** От цели стрелки до ноды, из которой она выходит; дальше по самой стрелке — снова к цели. */
  readonly nodes: NodeId[];
  /** Переходы «откуда>куда» между вершинами цикла, включая саму стрелку: что лежит на цикле. */
  readonly hops: ReadonlySet<string>;
};

/** Переход стрелки между вершинами: от выхода её начала ко входу её цели. */
function hopOf(view: GraphDraft, edge: GraphEdge): string | undefined {
  const fromId = view.sourceNodeId(edge.source);
  const from = fromId === undefined ? undefined : view.node(fromId);
  const to = view.node(edge.target.nodeId);
  return from && to ? `${endOf(from)}>${startOf(to)}` : undefined;
}

/**
 * Цикл, который замкнёт стрелка (в графе её ещё нет или она уже есть — неважно): путь от цели
 * стрелки обратно к ноде, из которой она выходит. null — цикла нет. sorted — обход по порядку
 * вершин: путь одинаковый у сервера и клиента (нужно, когда путь попадает в результат).
 */
export function edgeCyclePath(view: GraphDraft, edge: GraphEdge, sorted = false): CyclePath | null {
  const fromId = view.sourceNodeId(edge.source);
  const from = fromId === undefined ? undefined : view.node(fromId);
  const to = view.node(edge.target.nodeId);
  if (!from || !to) return null;
  // Стрелка «вперёд» по известному порядку зависимостей цикла не замкнёт: обход не нужен.
  if (view.order && isForward(view.order, view, edge)) return null;
  const goal = endOf(from);
  const root = startOf(to);
  const hops = new Set([`${goal}>${root}`]);
  if (root === goal) return { nodes: [from.id], hops };
  const found = searchFrom(view, sorted, [root], (next) => next === goal);
  if (!found) return null;
  const vertices = [...found.path, found.next];
  for (let i = 1; i < vertices.length; i++) hops.add(`${vertices[i - 1]}>${vertices[i]}`);
  return { nodes: pathNodes(vertices), hops };
}

/** Ноды цикла, который замкнёт стрелка; null — цикла нет. */
export function edgeCycle(view: GraphDraft, edge: GraphEdge): NodeId[] | null {
  return edgeCyclePath(view, edge)?.nodes ?? null;
}

/** Стрелка лежит на цикле: её переход между вершинами есть в пути. */
export function edgeOnCycle(view: GraphDraft, path: CyclePath, edge: GraphEdge): boolean {
  const hop = hopOf(view, edge);
  return hop !== undefined && path.hops.has(hop);
}

// ---- Порядок зависимостей ----

/** Шаг обхода: 'enter' — вход ноды (у роадмапы — её начало), 'exit' — выход (у роадмапы — конец). */
export type OrderStep = { readonly step: 'enter' | 'exit'; readonly id: NodeId };

export type DependencyOrder = {
  readonly steps: readonly OrderStep[];
  /** Место шага в steps: по нему пересчёт идёт в порядке зависимостей. */
  readonly enterRank: ReadonlyMap<NodeId, number>;
  readonly exitRank: ReadonlyMap<NodeId, number>;
  /** false — в графе цикл: ноды цикла и всё после них в порядок не попали. */
  readonly complete: boolean;
};

/**
 * Ноды в порядке зависимостей: вход ноды идёт после выходов всех, кого она ждёт, и после входа
 * её роадмапы; выход роадмапы — после выходов всех нод внутри. У блока и milestone вход и выход —
 * соседние шаги. Заодно это проверка на циклы: при цикле в порядок попадают не все ноды.
 *
 * Порядок однозначен: из готовых вершин первой берётся меньшая по id. Иначе он зависел бы от
 * порядка записей в памяти, и сервер с клиентом могли бы по-разному выбрать источник
 * предупреждения.
 */
export function dependencyOrder(view: GraphDraft): DependencyOrder {
  // Вершина v — нода nodes[v >> 1]: чётная — начало (у блока и milestone — единственная),
  // нечётная — конец роадмапы.
  const nodes = [...view.nodes.values()];
  const count = nodes.length;
  const ids = nodes.map((node) => node.id);
  const indexOf = new Map<NodeId, number>();
  for (let i = 0; i < count; i++) indexOf.set(ids[i]!, i);
  const endOf = (i: number): number => (nodes[i]!.type === 'roadmap' ? 2 * i + 1 : 2 * i);

  // Связи парами «откуда, куда», потом — сплошным массивом по вершинам: без массива на вершину.
  const links: number[] = [];
  for (let i = 0; i < count; i++) {
    const node = nodes[i]!;
    if (node.type === 'roadmap') links.push(2 * i, 2 * i + 1);
    const parent = node.parentId === null ? undefined : indexOf.get(node.parentId);
    if (parent !== undefined && nodes[parent]!.type === 'roadmap') {
      links.push(2 * parent, 2 * i, endOf(i), 2 * parent + 1);
    }
    for (const edgeId of view.edgesOut(node.id)) {
      const target = view.edge(edgeId)?.target.nodeId;
      const to = target === undefined ? undefined : indexOf.get(target);
      if (to !== undefined) links.push(endOf(i), 2 * to);
    }
  }
  const vertices = 2 * count;
  const offsets = new Int32Array(vertices + 1);
  const indegree = new Int32Array(vertices);
  for (let k = 0; k < links.length; k += 2) {
    offsets[links[k]! + 1]!++;
    indegree[links[k + 1]!]!++;
  }
  for (let v = 0; v < vertices; v++) offsets[v + 1]! += offsets[v]!;
  const targets = new Int32Array(links.length / 2);
  const cursor = offsets.slice(0, vertices);
  for (let k = 0; k < links.length; k += 2) targets[cursor[links[k]!]!++] = links[k + 1]!;

  const ready = new MinHeap((a, b) => {
    const idA = ids[a >> 1]!;
    const idB = ids[b >> 1]!;
    return idA < idB || (idA === idB && a < b);
  });
  for (let i = 0; i < count; i++) {
    if (indegree[2 * i] === 0) ready.push(2 * i);
    if (nodes[i]!.type === 'roadmap' && indegree[2 * i + 1] === 0) ready.push(2 * i + 1);
  }
  const steps: OrderStep[] = [];
  const enterRank = new Map<NodeId, number>();
  const exitRank = new Map<NodeId, number>();
  for (let vertex = ready.pop(); vertex !== undefined; vertex = ready.pop()) {
    const i = vertex >> 1;
    const id = ids[i]!;
    if (vertex === 2 * i) {
      enterRank.set(id, steps.length);
      steps.push({ step: 'enter', id });
    }
    if (vertex === endOf(i)) {
      exitRank.set(id, steps.length);
      steps.push({ step: 'exit', id });
    }
    for (let k = offsets[vertex]!; k < offsets[vertex + 1]!; k++) {
      const to = targets[k]!;
      if (--indegree[to]! === 0) ready.push(to);
    }
  }
  return { steps, enterRank, exitRank, complete: steps.length === 2 * count };
}

/**
 * Порядок зависимостей текущего состояния копии: запомненный или посчитанный заново. Для копии
 * без записей он запоминается и для самого графа.
 */
export function orderOf(view: GraphDraft): DependencyOrder {
  if (view.order) return view.order;
  const order = dependencyOrder(view);
  view.order = order;
  if (view.pristine) rememberOrder(view.base, order);
  return order;
}

/**
 * Стрелка идёт «вперёд» по порядку зависимостей: выход её начала стоит раньше входа её конца.
 * Такая стрелка не замыкает цикл, а порядок остаётся верным и после неё.
 */
export function isForward(order: DependencyOrder, view: GraphDraft, edge: GraphEdge): boolean {
  if (!order.complete) return false;
  const fromId = view.sourceNodeId(edge.source);
  const fromRank = fromId === undefined ? undefined : order.exitRank.get(fromId);
  const toRank = order.enterRank.get(edge.target.nodeId);
  return fromRank !== undefined && toRank !== undefined && fromRank < toRank;
}

/** Есть ли в графе цикл или тупик. Путь для подсветки — findCycle. */
export const hasCycle = (view: GraphDraft): boolean => !orderOf(view).complete;

/** Двоичная куча: первым выходит меньший по less. */
class MinHeap {
  private readonly items: number[] = [];

  constructor(private readonly less: (a: number, b: number) => boolean) {}

  push(item: number): void {
    const { items, less } = this;
    let i = items.push(item) - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(item, items[parent]!)) break;
      items[i] = items[parent]!;
      i = parent;
    }
    items[i] = item;
  }

  pop(): number | undefined {
    const { items, less } = this;
    const top = items[0];
    const last = items.pop();
    if (top === undefined || last === undefined || items.length === 0) return top;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= items.length) break;
      const right = left + 1;
      const child = right < items.length && less(items[right]!, items[left]!) ? right : left;
      if (!less(items[child]!, last)) break;
      items[i] = items[child]!;
      i = child;
    }
    items[i] = last;
    return top;
  }
}

// ---- Что идёт после ----

/** Откуда начинается распространение потери выполненности. */
export type SpreadStart<Tag> = {
  /** Метка, которую получат задачи, до которых дойдёт этот старт (источник предупреждения). */
  readonly tag: Tag;
  /** Ноды, которые блокируются. */
  readonly locked: readonly NodeId[];
  /** Ноды, которые перестают быть выполненными. */
  readonly notDone: readonly NodeId[];
};

/**
 * Задачи, которые затрагивает потеря выполненности, с меткой старта, который дошёл до них первым
 * (старты идут в заданном порядке, поэтому результат однозначен):
 * - нода перестала быть выполненной → блокируется всё по стрелкам от неё, а роадмапа, внутри
 *   которой она лежит, тоже перестаёт быть выполненной;
 * - заблокированная нода перестаёт быть выполненной, её задачи затронуты, а у роадмапы
 *   блокируется всё внутри.
 *
 * Стрелки от задач заблокированного блока дальше не ведут: сами эти задачи остаются
 * выполненными, и то, что ждёт только их, не блокируется.
 *
 * staysDone — нода осталась выполненной, хотя её задело (пометка «засчитано»): её задачи
 * затронуты, но дальше неё потеря не идёт.
 */
export function spreadLoss<Tag>(
  view: GraphDraft,
  starts: readonly SpreadStart<Tag>[],
  staysDone: (id: NodeId) => boolean,
): Map<TaskId, Tag> {
  const locked = new Set<NodeId>();
  const notDone = new Set<NodeId>();
  const reached = new Map<TaskId, Tag>();
  for (const start of starts) {
    const queue: { readonly lock: boolean; readonly id: NodeId }[] = [
      ...start.locked.map((id) => ({ lock: true, id })),
      ...start.notDone.map((id) => ({ lock: false, id })),
    ];
    for (let i = 0; i < queue.length; i++) {
      const { lock, id } = queue[i]!;
      if (lock) {
        if (locked.has(id)) continue;
        locked.add(id);
        for (const taskId of view.tasksIn(id))
          if (!reached.has(taskId)) reached.set(taskId, start.tag);
        for (const child of view.childrenOf(id)) queue.push({ lock: true, id: child });
        queue.push({ lock: false, id });
      } else {
        if (notDone.has(id) || staysDone(id)) continue;
        notDone.add(id);
        for (const edgeId of view.edgesOut(id)) {
          const edge = view.edge(edgeId);
          if (edge?.source.kind === 'node') queue.push({ lock: true, id: edge.target.nodeId });
        }
        const parentId = view.node(id)?.parentId;
        if (parentId !== undefined && parentId !== null) queue.push({ lock: false, id: parentId });
      }
    }
  }
  return reached;
}

/** Куда ведут стрелки от выхода задачи. */
export function taskEdgeTargets(view: GraphDraft, taskId: TaskId): NodeId[] {
  const targets: NodeId[] = [];
  for (const edgeId of view.edgesFromTask(taskId)) {
    const edge = view.edge(edgeId);
    if (edge) targets.push(edge.target.nodeId);
  }
  return targets;
}

/** Задачи после этой задачи: те, что окажутся заблокированы, если она и её блок перестанут быть выполненными. */
export function downstreamTasks(view: GraphDraft, taskId: TaskId): TaskId[] {
  const task = view.task(taskId);
  if (!task) return [];
  const counted = (id: NodeId): boolean => view.countedNodes().has(id);
  const reached = spreadLoss(
    view,
    [{ tag: true, locked: taskEdgeTargets(view, taskId), notDone: [task.blockId] }],
    counted,
  );
  reached.delete(taskId);
  return [...reached.keys()];
}
