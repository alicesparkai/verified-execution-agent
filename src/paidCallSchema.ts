// ── ЕДИНЫЙ ИСТОЧНИК ФОРМЫ ПЛАТНОГО ВЫЗОВА ───────────────────────────────────
//
// ЗАЧЕМ ОТДЕЛЬНЫМ ФАЙЛОМ (08.09).
// Схема жила внутри server.ts и применялась только там. Боевой тракт —
// serverX402.ts — её не видел, и в его челлендже outputSchema отсутствовал
// вовсе (проверено: 0 вхождений в файле).
//
// Что это значит для клиента: он платит, получает 402 без указания, ЧТО звать
// после оплаты, пробует GET и получает 405. Деньги списаны, услуга не оказана.
//
// Мой собственный рецепт от 25.07 (память/способности/рецепт-x402-валидация-
// листинга.md) требует прямо: «в каждый элемент accepts[] положить
// outputSchema.input — клиентские CLI, в том числе OKX, читают это, чтобы
// знать, как повторить запрос после оплаты».
//
// Рецепт был написан по шраму отказа листинга и применён В ОДНОМ файле из двух.
// Тот же класс, что positive_control (2 применения из 308): правило записано,
// охват не проверен.
//
// ⇒ Копию сюда НЕ делаю — выношу в общий модуль. Копия развела бы два
// источника правды, и они разошлись бы при первой же правке молча.

export const PAID_CALL_SCHEMA = {
  input: {
    type: 'http',
    method: 'POST',
    bodyType: 'json',
    body: {
      type: 'object',
      required: ['intent'],
      properties: {
        intent: {
          type: 'object',
          description: 'The on-chain intent to verify before execution.',
          properties: {
            action: { type: 'string', description: 'e.g. transfer | approve | contractCall' },
            to: { type: 'string', description: '0x-address of the target' },
            value: { type: 'string', description: 'amount in base units' },
            data: { type: 'string', description: 'optional calldata (0x…) — decoded and screened' },
            chainId: { type: 'number', description: 'optional EVM chain id' },
          },
        },
        rationale: { type: 'string', description: "optional: the agent's stated reason — checked for contradiction" },
      },
    },
  },
} as const;
