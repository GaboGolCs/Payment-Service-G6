import { paymentService } from '../src/services/payment.service';
import { paymentRepository } from '../src/repositories/payment.repository';
import { eventPublisher } from '../src/events/event.publisher';
import { PaymentStateError } from '../src/models/payment.model';

jest.mock('../src/repositories/payment.repository');
jest.mock('../src/events/event.publisher');

const mockRepo = paymentRepository as jest.Mocked<typeof paymentRepository>;
const mockPublisher = eventPublisher as jest.Mocked<typeof eventPublisher>;

const pendingPayment = (id = 'pay-001') => ({
  id,
  status: 'PENDING' as const,
  version: 0,
  amount: 100,
  currency: 'USD',
  orderId: 'order-x',
  idempotencyKey: null,
  metadata: null,
  description: null,
  payerEmail: null,
  mpPreferenceId: null,
  mpPaymentId: null,
  initPoint: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  confirmedAt: null,
  rejectedAt: null,
});

describe('PaymentService — Conceptos evaluados', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPublisher.publish = jest.fn().mockResolvedValue(undefined);
  });

  // ── CASO OBLIGATORIO: Race Condition ────────────────────────────────────
  describe('Race Condition', () => {
    it('should process only one confirmation when two arrive simultaneously', async () => {
      const payment = pendingPayment();

      // Ambas requests leen el mismo estado PENDING
      mockRepo.findById
        .mockResolvedValueOnce(payment) // request A lee
        .mockResolvedValueOnce(payment) // request B lee
        .mockResolvedValue({ ...payment, status: 'APPROVED', version: 1 });

      // Request A gana el lock (1 row updated), Request B llega tarde (0 rows)
      mockRepo.confirmWithOptimisticLock
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      const [resultA, resultB] = await Promise.allSettled([
        paymentService.confirmPayment('pay-001'),
        paymentService.confirmPayment('pay-001'),
      ]);

      const fulfilled = [resultA, resultB].filter((r) => r.status === 'fulfilled');
      const rejected = [resultA, resultB].filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);  // Solo uno aprobado
      expect(rejected).toHaveLength(1);   // El otro falla con ConflictError

      // El evento PaymentApproved se publica exactamente UNA vez
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      expect(mockPublisher.publish).toHaveBeenCalledWith('PaymentApproved', expect.any(Object));
    });
  });

  // ── Estados Transaccionales ─────────────────────────────────────────────
  describe('Estados transaccionales', () => {
    it('should reject confirmation of already APPROVED payment', async () => {
      mockRepo.findById.mockResolvedValue({
        ...pendingPayment('pay-002'),
        status: 'APPROVED',
        version: 1,
        confirmedAt: new Date(),
      });

      await expect(paymentService.confirmPayment('pay-002')).rejects.toThrow(PaymentStateError);
      await expect(paymentService.confirmPayment('pay-002')).rejects.toMatchObject({
        code: 'ALREADY_PROCESSED',
        currentStatus: 'APPROVED',
      });
    });

    it('should reject second rejection of already REJECTED payment', async () => {
      mockRepo.findById.mockResolvedValue({
        ...pendingPayment('pay-003'),
        status: 'REJECTED',
        version: 1,
        rejectedAt: new Date(),
      });

      await expect(paymentService.rejectPayment('pay-003')).rejects.toMatchObject({
        code: 'ALREADY_PROCESSED',
        currentStatus: 'REJECTED',
      });
    });
  });

  // ── Eventos (Eventual Consistency) ─────────────────────────────────────
  describe('Eventos', () => {
    it('should publish PaymentPending when payment is created', async () => {
      mockRepo.create.mockResolvedValue(pendingPayment('pay-new'));

      await paymentService.createPayment({ amount: 100, orderId: 'order-x' });

      expect(mockPublisher.publish).toHaveBeenCalledWith('PaymentPending', expect.objectContaining({
        paymentId: 'pay-new',
        orderId: 'order-x',
      }));
    });

    it('should publish PaymentApproved with correct payload after confirm', async () => {
      const payment = pendingPayment('pay-004');
      mockRepo.findById
        .mockResolvedValueOnce(payment)
        .mockResolvedValue({ ...payment, status: 'APPROVED', version: 1, confirmedAt: new Date() });
      mockRepo.confirmWithOptimisticLock.mockResolvedValue({ count: 1 });

      await paymentService.confirmPayment('pay-004');

      expect(mockPublisher.publish).toHaveBeenCalledWith('PaymentApproved', expect.objectContaining({
        paymentId: 'pay-004',
        amount: 100,
        currency: 'USD',
        orderId: 'order-x',
      }));
    });

    it('should publish PaymentRejected with correct payload after reject', async () => {
      const payment = pendingPayment('pay-005');
      mockRepo.findById
        .mockResolvedValueOnce(payment)
        .mockResolvedValue({ ...payment, status: 'REJECTED', version: 1, rejectedAt: new Date() });
      mockRepo.rejectWithOptimisticLock.mockResolvedValue({ count: 1 });

      await paymentService.rejectPayment('pay-005');

      expect(mockPublisher.publish).toHaveBeenCalledWith('PaymentRejected', expect.objectContaining({
        paymentId: 'pay-005',
      }));
    });
  });
});