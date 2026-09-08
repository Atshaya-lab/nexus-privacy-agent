export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DomAttributes {
  id?: string;
  name?: string;
  type?: string;
  placeholder?: string;
  value?: string;
  [key: string]: string | undefined;
}

export interface DomNode {
  tag: string;
  role: string | null;
  text: string;
  attributes: DomAttributes;
  boundingBox: BoundingBox;
}

export interface RawContext {
  url: string;
  timestamp: number;
  dom: DomNode[];
  screenshot: string;
}

export interface VisualRegion {
  bbox: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  extractedText: string;
  confidence: number;
}

export interface PerceptionMetrics {
  loadTimeMs: number;
  inferenceTimeMs: number;
  totalTimeMs: number;
  provider: 'webgpu' | 'wasm';
  isWarmRun: boolean;
  memoryUsageMB?: number;
  latencyBudgetExceeded: boolean;
  memoryBudgetExceeded: boolean;
}

export interface PerceivedContext extends RawContext {
  visualRegions?: VisualRegion[];
  perceptionSkipped?: boolean;
  perceptionReason?: string;
  perceptionMetrics?: PerceptionMetrics;
}

export type SensitivePiiType =
  | 'AADHAAR'
  | 'PAN'
  | 'NAME'
  | 'ADDRESS'
  | 'PHONE'
  | 'EMAIL'
  | 'FINANCIAL'
  | 'OTHER_SENSITIVE';

export interface RedactionTarget {
  regionIndex: number;
  bbox: { x: number; y: number; w: number; h: number };
  piiType: SensitivePiiType;
  originalLabel: string;
  matchedRule: string;
  confidence: number;
}

export interface RedactionSummary {
  totalRegionsEvaluated: number;
  sensitiveRegionsCount: number;
  preservedRegionsCount: number;
  redactedPiiTypes: SensitivePiiType[];
  trustBoundaryPassed: boolean;
  redactionPolicy: 'hybrid-spatial-label-proximity';
}

export interface ProtectedVisualRegion extends VisualRegion {
  isRedacted: boolean;
  redactionType?: SensitivePiiType;
  redactionReason?: string;
}

export interface ProtectedDomNode extends DomNode {
  isRedacted?: boolean;
  redactionType?: SensitivePiiType;
}

export interface ProtectedContext {
  url: string;
  timestamp: number;
  rawDom: DomNode[];
  protectedDom: ProtectedDomNode[];
  rawScreenshot: string;
  protectedScreenshot: string;
  visualRegions: ProtectedVisualRegion[];
  redactionTargets: RedactionTarget[];
  redactionSummary: RedactionSummary;
  perceptionSkipped?: boolean;
  perceptionMetrics?: PerceptionMetrics;
}

export type PolicyAction = 'BLOCK' | 'MASK' | 'ALLOW' | 'ASK';
export type PolicyRecord = Record<string, PolicyAction>;

export interface PiiClassification {
  category: string;
  source: 'dom' | 'visual';
  bbox: { x: number; y: number; width: number; height: number };
  matchedText?: string;
  confidenceInDetection: number;
  originalIndex?: number;
  originalItem?: any;
}

export interface AuditLogEntry {
  category: string;
  action: PolicyAction;
  source: 'dom' | 'visual';
  bbox: { x: number; y: number; width: number; height: number };
  timestamp: number;
  details?: string;
}

export interface SafeContext {
  url: string;
  timestamp: number;
  sanitizedDom: DomNode[];
  redactedScreenshot: string;
  rawScreenshot: string;
  auditLog: AuditLogEntry[];
  classifications: PiiClassification[];
  sanitizedVisualRegions: VisualRegion[];
  summary: {
    totalDetected: number;
    masked: number;
    blocked: number;
    allowed: number;
    pendingAsk: number;
  };
  pendingAskFields: PiiClassification[];
  policyApplied: PolicyRecord;
}

export type ActionType = 'click' | 'type' | 'scroll' | 'select';

export interface PlanAction {
  action: ActionType;
  targetSelector: string;
  value?: string | null;
  groundedBbox: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  confidence: number;
  reasoning: string;
}

export interface BlockedActionItem {
  step: string;
  groundedBbox: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  reason: string;
  auditEntry?: AuditLogEntry;
}

export interface AuditTrailItem {
  step: string;
  status: string;
  mode: string;
  targetSelector?: string;
  groundedBbox?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  confidence?: number;
  details: string;
  timestamp: number;
}

export interface PlanResponse {
  done: boolean;
  summary: string;
  groundingMode: string;
  actions: PlanAction[];
  blockedActions: BlockedActionItem[];
  auditTrail: AuditTrailItem[];
}

export interface ExecutionStepResult {
  stepIndex: number;
  action: PlanAction;
  status: 'SUCCESS' | 'FAILED' | 'BLOCKED';
  message: string;
  timestamp: number;
}

export interface ExecutionReport {
  totalSteps: number;
  executedSteps: number;
  results: ExecutionStepResult[];
  completedAt: number;
  success: boolean;
}

export type MessageRequest =
  | { type: 'GET_CONTEXT' }
  | { type: 'CAPTURE_SCREEN'; windowId?: number }
  | {
      type: 'EXECUTE_PLAN';
      actions: PlanAction[];
      safeContextAuditLog?: AuditLogEntry[];
    };


