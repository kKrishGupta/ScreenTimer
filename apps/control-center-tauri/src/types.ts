export type AgentStatus = {
  running: boolean;
  enrolled: boolean;
  deviceId: string | null;
  lifecycle: string;
  backendUrl: string | null;
  pendingQueue: number;
  totalRecorded: number;
  recoveryRequired: boolean;
  storageAvailable: boolean;
  statusDetail: string;
};

export type SessionState = { signedIn: boolean; email: string | null };
export type NativeError = { code?: string; message?: string };
