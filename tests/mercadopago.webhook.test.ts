import { mapMercadoPagoStatus } from '../src/services/mercadopago.service';

describe('mapMercadoPagoStatus', () => {
  it('maps "approved" to APPROVED', () => {
    expect(mapMercadoPagoStatus('approved')).toBe('APPROVED');
  });

  it.each(['rejected', 'cancelled', 'charged_back'])('maps "%s" to REJECTED', (status) => {
    expect(mapMercadoPagoStatus(status)).toBe('REJECTED');
  });

  it.each(['pending', 'in_process', 'in_mediation', 'authorized', 'refunded'])(
    'maps "%s" to PENDING (no-op, aún no es un estado final)',
    (status) => {
      expect(mapMercadoPagoStatus(status)).toBe('PENDING');
    }
  );
});

describe('PaymentService.handleMercadoPagoWebhook', () => {
  jest.mock('../src/repositories/payment.repository');
  jest.mock('../src/events/event.publisher');
  jest.mock('../src/services/mercadopago.service', () => {
    const actual = jest.requireActual('../src/services/mercadopago.service');
    return {
      ...actual,
      mercadoPagoService: {
        getPayment: jest.fn(),
        createPreference: jest.fn(),
        verifySignature: jest.fn(),
      },
    };
  });

  const { paymentRepository } = require('../src/repositories/payment.repository');
  const { eventPublisher } = require('../src/events/event.publisher');
  const { mercadoPagoService } = require('../src/services/mercadopago.service');
  const { paymentService } = require('../src/services/payment.service');

  const basePayment = {
    id: 'pay-mp-1',
    status: 'PENDING',
    version: 0,
    amount: 100,
    currency: 'CLP',
    orderId: 'order-1',
    mpPaymentId: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    eventPublisher.publish = jest.fn().mockResolvedValue(undefined);
  });

  it('applies APPROVED transition and publishes PaymentApproved exactly once', async () => {
    mercadoPagoService.getPayment.mockResolvedValue({
      id: 987654321,
      status: 'approved',
      external_reference: 'pay-mp-1',
    });
    paymentRepository.findById = jest
      .fn()
      .mockResolvedValueOnce(basePayment)
      .mockResolvedValueOnce({ ...basePayment, status: 'APPROVED', version: 1 });
    paymentRepository.applyMercadoPagoTransition = jest.fn().mockResolvedValue({ count: 1 });

    const result = await paymentService.handleMercadoPagoWebhook('987654321');

    expect(paymentRepository.applyMercadoPagoTransition).toHaveBeenCalledWith(
      'pay-mp-1',
      0,
      'APPROVED',
      '987654321'
    );
    expect(eventPublisher.publish).toHaveBeenCalledTimes(1);
    expect(eventPublisher.publish).toHaveBeenCalledWith('PaymentApproved', expect.any(Object));
    expect(result.ignored).toBe(false);
  });

  it('is idempotent: a second notification for an already-processed payment does not republish', async () => {
    mercadoPagoService.getPayment.mockResolvedValue({
      id: 987654321,
      status: 'approved',
      external_reference: 'pay-mp-1',
    });
    paymentRepository.findById = jest
      .fn()
      .mockResolvedValue({ ...basePayment, status: 'APPROVED', version: 1 });

    const result = await paymentService.handleMercadoPagoWebhook('987654321');

    expect(result).toMatchObject({ ignored: true, alreadyProcessed: true });
    expect(eventPublisher.publish).not.toHaveBeenCalled();
  });
});
