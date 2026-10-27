import { generateKeyPairSync } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EMPTY_MEMORY, acceptKeySet, evaluateLicense, type KeySet } from '@platform/licensing';
import { AuditService } from '../common/audit.service';
import { DomainError } from '../common/domain-error';
import { DB, type Db } from '../db/tokens';
import { ParentRefusal, type ActivationResponse } from './central-admin.client';
import { alreadyActivated, LicenceStore } from './licence.store';
import { LICENSING_CONFIG, type LicensingConfig } from './licensing.config';

export type { LicensingConfig } from './licensing.config';

/**
 * A fresh Ed25519 pair for the installation. `seed` is the raw 32-byte private
 * seed and `publicKey` the raw 32-byte public key, both base64url: the JWK `d`
 * and `x` members are exactly those encodings, and signRequest takes the seed.
 */
export function newInstallationKeyPair(): { publicKey: string; seed: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  const d = privateKey.export({ format: 'jwk' }).d;
  if (!x || !d) throw new Error('Ed25519 JWK export is missing x or d');
  return { publicKey: x, seed: d };
}

function rejected(reason: string): DomainError {
  return new DomainError(
    'activation_rejected',
    'Licenca dobijena pri aktivaciji nije prošla proveru, pa instalacija nije aktivirana.',
    422,
    { reason },
  );
}

@Injectable()
export class ActivationService {
  private readonly logger = new Logger(ActivationService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: LicenceStore,
    private readonly audit: AuditService,
    @Inject(LICENSING_CONFIG) private readonly config: LicensingConfig,
  ) {}

  /**
   * Activates this installation with a code from the Central Admin Panel.
   * Stores the installation only when the key set chains from the pinned root
   * and the licence verifies as VALID or GRACE for the installation id the
   * Admin Panel returned; otherwise nothing is stored.
   */
  async activate(code: string): Promise<void> {
    const { client, rootKeySet, secretBox } = this.config;
    if (!client || !rootKeySet || !secretBox) {
      throw new DomainError(
        'licensing_not_configured',
        'Licenciranje nije podešeno (CENTRAL_ADMIN_URL, HOTEL_ROOT_KEYSET, HOTEL_SECRET_KEY).',
        503,
      );
    }
    // Checked before calling the Admin Panel so a second attempt never burns a code.
    if (await this.store.get()) throw alreadyActivated();

    const pair = newInstallationKeyPair();
    let response: ActivationResponse;
    try {
      response = await client.activate(code.trim(), pair.publicKey);
    } catch (err) {
      if (err instanceof ParentRefusal) {
        throw new DomainError(err.code, err.message, err.status);
      }
      throw new DomainError(
        'central_admin_unavailable',
        'Centralni admin trenutno nije dostupan. Pokušajte ponovo; kod nije iskorišćen.',
        503,
      );
    }

    // The key set first: it must chain from the pinned root. A set equal to or
    // older than the root (stale_keyset, reported only for an authentic set)
    // adds nothing, so the root stays the trusted set.
    let trusted: KeySet = rootKeySet;
    const acceptance = acceptKeySet(response.keySet, rootKeySet);
    if (acceptance.ok) {
      trusted = acceptance.keySet;
    } else if (acceptance.reason !== 'stale_keyset') {
      this.logger.warn(`Activation key set refused: ${acceptance.reason}`);
      throw rejected(`keyset_${acceptance.reason}`);
    }

    const evaluation = evaluateLicense({
      envelope: response.license,
      installationId: response.installationId,
      keySet: trusted,
      memory: { ...EMPTY_MEMORY },
      now: (this.config.now ?? (() => new Date()))(),
    });
    if (evaluation.state !== 'VALID' && evaluation.state !== 'GRACE') {
      const reason = evaluation.state === 'INVALID' ? evaluation.reason : evaluation.state.toLowerCase();
      this.logger.warn(`Activation licence refused: ${reason}`);
      throw rejected(reason);
    }

    await this.db.transaction(async (tx) => {
      await this.store.saveActivation(
        {
          installationId: response.installationId,
          privateSeedEnc: secretBox.seal(pair.seed),
          envelope: response.license,
          keySet: trusted,
          memory: evaluation.memory,
        },
        tx,
      );
      await this.audit.record(tx, {
        propertyId: null,
        actorUserId: null,
        action: 'installation.activate',
        entity: 'installation',
        entityId: response.installationId,
        after: { revision: evaluation.payload.revision, state: evaluation.state },
      });
    });
  }
}
