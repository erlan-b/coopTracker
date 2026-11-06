// Рабочая копия графа и указатели для быстрых обходов.
//
// Граф неизменяемый. Операция пишет в рабочую копию (GraphDraft): словарь копируется только при
// первой записи в него, а в конце копия отдаёт новый граф. Неизменённые словари и записи остаются
// теми же объектами. Вместе с записями обновляются указатели (задачи блока, стрелки ноды и т. п.),
// поэтому проверки и обходы смотрят только на соседей, а не перебирают весь граф.
//
// Указатели, порядок зависимостей и выполненность нод запоминаются для каждого графа (по самому
// объекту графа, WeakMap): следующая операция над этим графом берёт их готовыми.

import type { DonenessState } from './doneness';
import type { EdgeId, NodeId, TaskId } from './ids';
import type { DependencyOrder } from './structure';
import type { EdgeSource, Graph, GraphEdge, GraphNode, Task } from './types';
import { sameValue } from './values';

/**
 * Кто на кого ссылается. Ключ — id, на который ссылаются; самой записи с таким id может уже не
 * быть (по этому проверка инвариантов находит висячие ссылки).
 */
export type GraphIndex = {
  /** Задачи блока. */
  readonly tasksIn: ReadonlyMap<NodeId, ReadonlySet<TaskId>>;
  /** Ноды внутри роадмапы. */
  readonly children: ReadonlyMap<NodeId, ReadonlySet<NodeId>>;
  /** Стрелки, входящие в ноду. */
  readonly edgesInto: ReadonlyMap<NodeId, ReadonlySet<EdgeId>>;
  /** Стрелки, выходящие из ноды: из её шапки и из её задач. */
  readonly edgesOut: ReadonlyMap<NodeId, ReadonlySet<EdgeId>>;
  /** Стрелки от выхода задачи. */
  readonly edgesFromTask: ReadonlyMap<TaskId, ReadonlySet<EdgeId>>;
  /** Ноды с пометкой «засчитано»: их выполненность перепроверяется на каждой операции. */
  readonly counted: ReadonlySet<NodeId>;
};

/** Посчитанное для графа: указатели, порядок зависимостей, выполненность (по настройкам envi). */
type Derived = {
  readonly index: GraphIndex;
  order: DependencyOrder | undefined;
  doneness: ReadonlyMap<string, DonenessState>;
};

const derivedCache = new WeakMap<Graph, Derived>();

function derivedOf(graph: Graph): Derived {
  let derived = derivedCache.get(graph);
  if (!derived) {
    derived = { index: buildIndex(graph), order: undefined, doneness: new Map() };
    derivedCache.set(graph, derived);
  }
  return derived;
}

/** Указатели графа с нуля. */
export function buildIndex(graph: Graph): GraphIndex {
  const tasksIn = new Map<NodeId, Set<TaskId>>();
  const children = new Map<NodeId, Set<NodeId>>();
  const edgesInto = new Map<NodeId, Set<EdgeId>>();
  const edgesOut = new Map<NodeId, Set<EdgeId>>();
  const edgesFromTask = new Map<TaskId, Set<EdgeId>>();
  const counted = new Set<NodeId>();
  for (const node of graph.nodes.values()) {
    if (node.parentId !== null) addTo(children, node.parentId, node.id);
    if (node.countedDone !== null) counted.add(node.id);
  }
  for (const task of graph.tasks.values()) addTo(tasksIn, task.blockId, task.id);
  for (const edge of graph.edges.values()) {
    addTo(edgesInto, edge.target.nodeId, edge.id);
    const { source } = edge;
    if (source.kind === 'node') {
      addTo(edgesOut, source.nodeId, edge.id);
    } else {
      addTo(edgesFromTask, source.taskId, edge.id);
      const task = graph.tasks.get(source.taskId);
      if (task) addTo(edgesOut, task.blockId, edge.id);
    }
  }
  return { tasksIn, children, edgesInto, edgesOut, edgesFromTask, counted };
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

const NONE: ReadonlySet<never> = new Set();

// ---- Копирование при первой записи ----

/** Словарь записей: копируется при первой записи и помнит, что было в изменённых ключах. */
class DraftMap<K, V> {
  private map: ReadonlyMap<K, V>;
  private owned: Map<K, V> | null = null;
  /** Значения до первой записи с начала работы копии: из них — итоговые изменения. */
  readonly initial = new Map<K, V | undefined>();
  /** Значения до первой записи с начала шага: из них — последствия одной операции. */
  step = new Map<K, V | undefined>();

  constructor(readonly base: ReadonlyMap<K, V>) {
    this.map = base;
  }

  get current(): ReadonlyMap<K, V> {
    return this.map;
  }

  set(key: K, value: V): void {
    this.remember(key);
    this.own().set(key, value);
  }

  delete(key: K): void {
    if (!this.map.has(key)) return;
    this.remember(key);
    this.own().delete(key);
  }

  /**
   * Итоговый словарь. Запись, которая вернулась к прежнему значению (переместили туда и
   * обратно), снова становится прежним объектом; если так со всеми — исходный словарь.
   */
  result(): ReadonlyMap<K, V> {
    let changed = false;
    for (const [key, was] of this.initial) {
      const now = this.map.get(key);
      if (now === was) continue;
      if (was !== undefined && now !== undefined && sameValue(was, now)) {
        this.own().set(key, was);
      } else {
        changed = true;
      }
    }
    return changed ? this.map : this.base;
  }

  private remember(key: K): void {
    const was = this.map.get(key);
    if (!this.initial.has(key)) this.initial.set(key, was);
    if (!this.step.has(key)) this.step.set(key, was);
  }

  private own(): Map<K, V> {
    if (!this.owned) {
      this.owned = new Map(this.map);
      this.map = this.owned;
    }
    return this.owned;
  }
}

/** Указатель «ключ → множество»: копируется внешний словарь и только затронутые множества. */
class DraftIndex<K, V> {
  private map: ReadonlyMap<K, ReadonlySet<V>>;
  private owned: Map<K, ReadonlySet<V>> | null = null;
  private readonly ownedSets = new Set<K>();

  constructor(base: ReadonlyMap<K, ReadonlySet<V>>) {
    this.map = base;
  }

  get current(): ReadonlyMap<K, ReadonlySet<V>> {
    return this.map;
  }

  get(key: K): ReadonlySet<V> {
    return this.map.get(key) ?? NONE;
  }

  add(key: K, value: V): void {
    if (!this.map.get(key)?.has(value)) this.mutable(key).add(value);
  }

  remove(key: K, value: V): void {
    if (!this.map.get(key)?.has(value)) return;
    const set = this.mutable(key);
    set.delete(value);
    if (set.size === 0) {
      this.own().delete(key);
      this.ownedSets.delete(key);
    }
  }

  private mutable(key: K): Set<V> {
    const map = this.own();
    const existing = map.get(key);
    if (existing && this.ownedSets.has(key)) return existing as Set<V>;
    const copy = new Set(existing);
    map.set(key, copy);
    this.ownedSets.add(key);
    return copy;
  }

  private own(): Map<K, ReadonlySet<V>> {
    if (!this.owned) {
      this.owned = new Map(this.map);
      this.map = this.owned;
    }
    return this.owned;
  }
}

/** Множество: копируется при первом изменении. */
class DraftSet<V> {
  private set: ReadonlySet<V>;
  private owned: Set<V> | null = null;

  constructor(base: ReadonlySet<V>) {
    this.set = base;
  }

  get current(): ReadonlySet<V> {
    return this.set;
  }

  toggle(value: V, present: boolean): void {
    if (this.set.has(value) === present) return;
    if (!this.owned) {
      this.owned = new Set(this.set);
      this.set = this.owned;
    }
    if (present) this.owned.add(value);
    else this.owned.delete(value);
  }
}

/** Что изменилось за шаг: id и запись до шага (undefined — её не было). */
export type Step = {
  readonly nodes: ReadonlyMap<NodeId, GraphNode | undefined>;
  readonly tasks: ReadonlyMap<TaskId, Task | undefined>;
  readonly edges: ReadonlyMap<EdgeId, GraphEdge | undefined>;
};

/**
 * Рабочая копия графа. Без записей — просто граф с указателями (для чтения и обходов).
 *
 * Пишут в неё только функции graph-core. Удаление записи не трогает ссылки на неё: каскад
 * (задачи и стрелки удалённой ноды) делает вызывающий.
 */
export class GraphDraft {
  readonly base: Graph;
  /** Порядок зависимостей текущего состояния; сбрасывается, когда меняется структура. */
  order: DependencyOrder | undefined;

  private readonly nodeMap: DraftMap<NodeId, GraphNode>;
  private readonly taskMap: DraftMap<TaskId, Task>;
  private readonly edgeMap: DraftMap<EdgeId, GraphEdge>;
  private readonly tasksInIndex: DraftIndex<NodeId, TaskId>;
  private readonly childrenIndex: DraftIndex<NodeId, NodeId>;
  private readonly edgesIntoIndex: DraftIndex<NodeId, EdgeId>;
  private readonly edgesOutIndex: DraftIndex<NodeId, EdgeId>;
  private readonly edgesFromTaskIndex: DraftIndex<TaskId, EdgeId>;
  private readonly countedSet: DraftSet<NodeId>;
  /** Удалённые задачи: чтобы найти блок их стрелок, если стрелки удаляются после задачи. */
  private readonly removedTasks = new Map<TaskId, Task>();
  /** Выполненность нод по настройкам envi на момент последнего settled(). */
  private settledDoneness: ReadonlyMap<string, DonenessState>;
  /** Были записи после последнего settled(): выполненность могла измениться. */
  private unsettled = false;
  private written = false;
  private structureWritten = false;
  private finished = false;

  constructor(base: Graph) {
    const derived = derivedOf(base);
    this.base = base;
    this.order = derived.order;
    this.settledDoneness = derived.doneness;
    this.nodeMap = new DraftMap(base.nodes);
    this.taskMap = new DraftMap(base.tasks);
    this.edgeMap = new DraftMap(base.edges);
    this.tasksInIndex = new DraftIndex(derived.index.tasksIn);
    this.childrenIndex = new DraftIndex(derived.index.children);
    this.edgesIntoIndex = new DraftIndex(derived.index.edgesInto);
    this.edgesOutIndex = new DraftIndex(derived.index.edgesOut);
    this.edgesFromTaskIndex = new DraftIndex(derived.index.edgesFromTask);
    this.countedSet = new DraftSet(derived.index.counted);
  }

  // ---- Чтение ----

  /** Записей ещё не было: копия совпадает с исходным графом. */
  get pristine(): boolean {
    return !this.written;
  }

  /** Были записи, которые меняют структуру зависимостей: ноды, роадмапы, стрелки. */
  get structureChanged(): boolean {
    return this.structureWritten;
  }

  get nodes(): ReadonlyMap<NodeId, GraphNode> {
    return this.nodeMap.current;
  }
  get tasks(): ReadonlyMap<TaskId, Task> {
    return this.taskMap.current;
  }
  get edges(): ReadonlyMap<EdgeId, GraphEdge> {
    return this.edgeMap.current;
  }
  node(id: NodeId): GraphNode | undefined {
    return this.nodeMap.current.get(id);
  }
  task(id: TaskId): Task | undefined {
    return this.taskMap.current.get(id);
  }
  edge(id: EdgeId): GraphEdge | undefined {
    return this.edgeMap.current.get(id);
  }
  tasksIn(blockId: NodeId): ReadonlySet<TaskId> {
    return this.tasksInIndex.get(blockId);
  }
  childrenOf(roadmapId: NodeId): ReadonlySet<NodeId> {
    return this.childrenIndex.get(roadmapId);
  }
  edgesInto(nodeId: NodeId): ReadonlySet<EdgeId> {
    return this.edgesIntoIndex.get(nodeId);
  }
  edgesOut(nodeId: NodeId): ReadonlySet<EdgeId> {
    return this.edgesOutIndex.get(nodeId);
  }
  edgesFromTask(taskId: TaskId): ReadonlySet<EdgeId> {
    return this.edgesFromTaskIndex.get(taskId);
  }
  /** Ноды с пометкой «засчитано». */
  countedNodes(): ReadonlySet<NodeId> {
    return this.countedSet.current;
  }

  /** Нода, из которой выходит стрелка: сама нода или блок задачи. */
  sourceNodeId(source: EdgeSource): NodeId | undefined {
    if (source.kind === 'node') return source.nodeId;
    return (this.task(source.taskId) ?? this.removedTasks.get(source.taskId))?.blockId;
  }

  // ---- Запись ----

  putNode(node: GraphNode): void {
    this.writable();
    const old = this.node(node.id);
    const oldParent = old === undefined ? null : old.parentId;
    if (old === undefined || oldParent !== node.parentId) {
      if (oldParent !== null) this.childrenIndex.remove(oldParent, node.id);
      if (node.parentId !== null) this.childrenIndex.add(node.parentId, node.id);
    }
    if (old === undefined || old.type !== node.type || oldParent !== node.parentId) {
      this.resetOrder();
    }
    this.countedSet.toggle(node.id, node.countedDone !== null);
    this.nodeMap.set(node.id, node);
  }

  removeNode(id: NodeId): void {
    this.writable();
    const old = this.node(id);
    if (!old) return;
    if (old.parentId !== null) this.childrenIndex.remove(old.parentId, id);
    this.countedSet.toggle(id, false);
    this.resetOrder();
    this.nodeMap.delete(id);
  }

  putTask(task: Task): void {
    this.writable();
    const current = this.task(task.id);
    if (current?.blockId !== task.blockId) {
      if (current) this.tasksInIndex.remove(current.blockId, task.id);
      this.tasksInIndex.add(task.blockId, task.id);
    }
    // Стрелки задачи выходят из её блока. У удалённой задачи они остаются под её последним блоком.
    const indexedUnder = (current ?? this.removedTasks.get(task.id))?.blockId;
    if (indexedUnder !== task.blockId) {
      for (const edgeId of [...this.edgesFromTask(task.id)]) {
        if (indexedUnder !== undefined) this.edgesOutIndex.remove(indexedUnder, edgeId);
        this.edgesOutIndex.add(task.blockId, edgeId);
        this.resetOrder();
      }
    }
    this.removedTasks.delete(task.id);
    this.taskMap.set(task.id, task);
  }

  removeTask(id: TaskId): void {
    this.writable();
    const old = this.task(id);
    if (!old) return;
    this.tasksInIndex.remove(old.blockId, id);
    this.removedTasks.set(id, old);
    this.taskMap.delete(id);
  }

  putEdge(edge: GraphEdge): void {
    this.writable();
    const old = this.edge(edge.id);
    if (old) this.unindexEdge(old);
    this.indexEdge(edge);
    this.resetOrder();
    this.edgeMap.set(edge.id, edge);
  }

  removeEdge(id: EdgeId): void {
    this.writable();
    const old = this.edge(id);
    if (!old) return;
    this.unindexEdge(old);
    this.resetOrder();
    this.edgeMap.delete(id);
  }

  private indexEdge(edge: GraphEdge): void {
    this.edgesIntoIndex.add(edge.target.nodeId, edge.id);
    if (edge.source.kind === 'task') this.edgesFromTaskIndex.add(edge.source.taskId, edge.id);
    const from = this.sourceNodeId(edge.source);
    if (from !== undefined) this.edgesOutIndex.add(from, edge.id);
  }

  private unindexEdge(edge: GraphEdge): void {
    this.edgesIntoIndex.remove(edge.target.nodeId, edge.id);
    if (edge.source.kind === 'task') this.edgesFromTaskIndex.remove(edge.source.taskId, edge.id);
    const from = this.sourceNodeId(edge.source);
    if (from !== undefined) this.edgesOutIndex.remove(from, edge.id);
  }

  private resetOrder(): void {
    this.order = undefined;
    this.structureWritten = true;
  }

  private writable(): void {
    if (this.finished) throw new Error('GraphDraft: запись после finish()');
    this.unsettled = true;
    this.written = true;
  }

  // ---- Выполненность ----

  /**
   * Выполненность нод по настройкам envi на конец последнего шага, после которого вызван
   * settled(); undefined — не посчитана.
   */
  donenessAtStep(key: string): DonenessState | undefined {
    return this.settledDoneness.get(key);
  }

  /** Последствия шага учтены: выполненность для этих настроек (остальные настройки забываются). */
  settled(key: string, state: DonenessState | undefined): void {
    this.settledDoneness = state === undefined ? new Map() : new Map([[key, state]]);
    this.unsettled = false;
  }

  // ---- Шаги и итог ----

  /** Что изменилось с начала шага (для последствий одной операции). Шаг не сбрасывается. */
  peekStep(): Step {
    return { nodes: this.nodeMap.step, tasks: this.taskMap.step, edges: this.edgeMap.step };
  }

  /** Что изменилось с начала шага; следующий шаг начинается с нуля. */
  takeStep(): Step {
    const step = this.peekStep();
    this.nodeMap.step = new Map();
    this.taskMap.step = new Map();
    this.edgeMap.step = new Map();
    return step;
  }

  /** Все изменения копии: id и запись в исходном графе (undefined — её не было). */
  touched(): Step {
    return {
      nodes: this.nodeMap.initial,
      tasks: this.taskMap.initial,
      edges: this.edgeMap.initial,
    };
  }

  /**
   * Новый граф. Если ничего не изменилось — исходный граф. Указатели, порядок и выполненность
   * запоминаются для нового графа, и следующая операция возьмёт их готовыми. После finish()
   * в копию писать нельзя: её множества теперь принадлежат новому графу.
   */
  finish(): Graph {
    this.finished = true;
    const nodes = this.nodeMap.result();
    const tasks = this.taskMap.result();
    const edges = this.edgeMap.result();
    const base = this.base;
    const doneness = this.unsettled ? new Map<string, DonenessState>() : this.settledDoneness;
    if (nodes === base.nodes && tasks === base.tasks && edges === base.edges) {
      const derived = derivedOf(base);
      derived.order ??= this.order;
      if (derived.doneness.size === 0) derived.doneness = doneness;
      return base;
    }
    const graph: Graph = { nodes, tasks, edges };
    derivedCache.set(graph, {
      index: {
        tasksIn: this.tasksInIndex.current,
        children: this.childrenIndex.current,
        edgesInto: this.edgesIntoIndex.current,
        edgesOut: this.edgesOutIndex.current,
        edgesFromTask: this.edgesFromTaskIndex.current,
        counted: this.countedSet.current,
      },
      order: this.order,
      doneness,
    });
    return graph;
  }
}

/** Граф для чтения и обходов: рабочая копия без записей. */
export const viewOf = (graph: Graph): GraphDraft => new GraphDraft(graph);

/** Запомненное для графа (для проверок в тестах). */
export function cachedDerived(graph: Graph): Readonly<Derived> | undefined {
  return derivedCache.get(graph);
}

/** Запомнить посчитанное для графа (вычисления над графом без рабочей копии). */
export function rememberOrder(graph: Graph, order: DependencyOrder): void {
  derivedOf(graph).order = order;
}

export function rememberDoneness(graph: Graph, key: string, state: DonenessState): void {
  const derived = derivedOf(graph);
  const map = new Map(derived.doneness);
  map.set(key, state);
  derived.doneness = map;
}
