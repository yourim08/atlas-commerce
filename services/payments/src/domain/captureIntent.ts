import { AppError, ConflictError, NotFoundError, type Idempotency, type Logger } from "@atlas/shared";
import type { IntentsRepo } from "../repositories/intentsRepo.js";
import type { AttemptsRepo } from "../repositories/attemptsRepo.js";
import type { PspProvider } from "../provider/pspProvider.js";
import type { SettlementClient } from "../clients/settlementClient.js";
import type { PaymentIntent } from "../types.js";

const CAPTURE_TTL_SEC = 24 * 60 * 60;

export interface CaptureDeps {
  intents: IntentsRepo;
  attempts: AttemptsRepo;
  provider: PspProvider;
  settlement: SettlementClient;
  idempotency: Idempotency;
  logger: Logger;
}

export function captureIntentUseCase(deps: CaptureDeps) {
  return async function captureIntent(
    intentId: string,
    idempotencyKey: string
  ): Promise<PaymentIntent> {
    // PSP 요청을 구분하기 위한 요청 ID
    // 매 호출마다 새로운 값이어야 하므로 timestamp와 hrtime을 사용한다.
    const requestedAt = `${Date.now()}:${process.hrtime.bigint()}`;

    const { result } = await deps.idempotency.run(
      // Idempotency Key는 동일한 요청이면 항상 동일해야 한다.
      // 기존 구현은 requestedAt을 포함하여 매 요청마다 다른 Key가 생성되어 멱등성 캐시를 활용하지 못하는 문제가 있었다.
      `capture:${idempotencyKey}`,
      CAPTURE_TTL_SEC,
      async () => {
        const intent = await deps.intents.findById(intentId);

        if (!intent) {
          throw new NotFoundError("payment intent not found");
        }

        if (intent.status === "succeeded") {
          return intent;
        }

        if (
          intent.status !== "requires_capture" &&
          intent.status !== "processing"
        ) {
          throw new ConflictError(`intent is ${intent.status}`);
        }

        // [Improvement]
        // PSP 요청 식별자는 매 요청마다 달라져야 하므로
        // requestedAt을 계속 사용한다.
        const psp = await deps.provider.capture(
          `${intent.id}:${requestedAt}`,
          intent.amountCents,
          intent.currency
        );

        await deps.attempts.record({
          intentId: intent.id,
          status: psp.ok ? "succeeded" : "failed",
          providerRef: psp.providerRef,
          errorCode: psp.errorCode ?? null,
        });

        if (!psp.ok) {
          await deps.intents.updateStatus(
            intent.id,
            ["requires_capture", "processing"],
            "failed"
          );

          throw new AppError(
            "CAPTURE_DECLINED",
            402,
            psp.errorCode ?? "capture declined"
          );
        }

        const updated = await deps.intents.updateStatus(
          intent.id,
          ["requires_capture", "processing"],
          "succeeded"
        );

        await deps.settlement.postLedgerEntry({
          account: "merchant_receivable",
          orderId: intent.orderId,
          paymentIntentId: intent.id,
          amountCents: intent.amountCents,
          currency: intent.currency,
          entryType: "charge",
          externalRef: psp.providerRef,
        });

        const captured =
          updated ?? { ...intent, status: "succeeded" as const };

        return {
          ...captured,
          providerRef: psp.providerRef,
        };
      }
    );

    return result;
  };
}