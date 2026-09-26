export type PaymentStatus = "pending" | "confirmed";

export interface SubPayer {
  id: string;
  name: string;
  phone: string;
  amount: number;
}

export interface Participant {
  id: string;
  name: string;
  phone: string;
  subPayers?: SubPayer[];
}

export interface HistoryEntry {
  collectorId: string;
  monthLabel: string;
  collectedAt: string;
  payments: Record<string, PaymentStatus | string>;
}

export interface Batch {
  id: string;
  name: string;
  amount: number;
  currency: string;
  startMonth: string;
  createdAt: string;
  archived: boolean;
  participants: Participant[];
  queue: string[];
  history: HistoryEntry[];
  currentPayments: Record<string, PaymentStatus | string>;
}

export interface PaymentDetails {
  accountNumber: string;
  accountName: string;
  bankName: string;
}

export interface LedgerState {
  batches: Batch[];
  pinSet: boolean;
  paymentDetails: PaymentDetails;
}

export interface ApiError {
  error: string;
  message?: string;
}

export interface NewBatchDraftParticipant {
  name: string;
  subNames: string[];
}

export interface NewBatchDraft {
  name: string;
  amount: string;
  startMonth: string;
  participants: NewBatchDraftParticipant[];
  copayerFor: number | null;
}

export interface EditBatchDraft {
  batchId: string;
  name: string;
  amount: number | string;
  startMonth: string;
}

export interface AddParticipantDraft {
  name: string;
  phone: string;
  subNames: string[];
  copayerOpen: boolean;
}

export interface ChangePinDraft {
  newPin: string;
  confirmPin: string;
}
