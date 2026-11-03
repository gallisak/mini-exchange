import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SubmitOrderDto } from '../src/orders/dto/submit-order.dto';

const invalidFields = async (body: Record<string, unknown>) => {
  const errors = await validate(plainToInstance(SubmitOrderDto, body), { whitelist: true });
  return errors.map((error) => error.property).sort();
};

const valid = { instrument: 'ABC', side: 'buy', price: '100.50', quantity: '1.5' };

describe('order validation', () => {
  it('accepts price and quantity as decimal strings', async () => {
    await expect(invalidFields(valid)).resolves.toEqual([]);
  });

  it.each([0.001, '0.001'])('rejects a price with more than two decimal places (%p)', async (price) => {
    await expect(invalidFields({ ...valid, price })).resolves.toEqual(['price']);
  });

  it.each([0.000000001, '0.000000001'])(
    'rejects a quantity with more than eight decimal places (%p)',
    async (quantity) => {
      await expect(invalidFields({ ...valid, quantity })).resolves.toEqual(['quantity']);
    },
  );

  it.each([1e30, '1000000000000000000000000000000'])(
    'rejects a price that does not fit numeric(18,2) (%p)',
    async (price) => {
      await expect(invalidFields({ ...valid, price })).resolves.toEqual(['price']);
    },
  );

  it.each([1e11, '100000000000'])(
    'rejects a quantity that does not fit numeric(18,8) (%p)',
    async (quantity) => {
      await expect(invalidFields({ ...valid, quantity })).resolves.toEqual(['quantity']);
    },
  );

  it.each([0, '0', '0.00', -1, '-1', '1e2', ' 1', ''])(
    'rejects a malformed or non-positive price (%p)',
    async (price) => {
      await expect(invalidFields({ ...valid, price })).resolves.toEqual(['price']);
    },
  );

  it('rejects an instrument that is not listed', async () => {
    await expect(invalidFields({ ...valid, instrument: 'NOPE' })).resolves.toEqual(['instrument']);
  });
});
