import { generateKeyPairSync } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  EMPTY_MEMORY,
  acceptKeySet,
  canonicalize,
  evaluateLicense,
  type KeySet,
  type SignedKeySet,
} from '@platform/licensing';
import { sql } from 'drizzle-orm';
import { AuditService } from '../common/audit.service';
import { DomainError } from '../common/domain-error';
import { DB, type Db } from '../db/tokens';
import {
  ParentRefusal,
  ParentUnavailable,
  type ActivationResponse,
  type CentralAdminClient,
} from './central-admin.client';
import { alreadyActivated, LicenceStore } from './licence.store';
import { LICENSING_CONFIG, type LicensingConfig } from './licensing.config';

export type { LicensingConfig } from './licensing.config';

/** The product this installation's licence must be issued for. */
export const PRODUCT = 'hotel';

/** Transaction-scoped advisory lock serialising activations across API instances. */
export const ACTIVATION_LOCK_KEY = 7_301_002;

/** Upper bound on `GET /v1/keys?since=` pages walked in one activation. */
const MAX_KEY_PAGES = 10;

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

/** Byte-identical signed sets (RFC 8785 canonical form). Never throws. */
function sameSignedSet(a: SignedKeySet, b: unknown): boolean {
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
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
   * and the licence verifies as VALID or GRACE, for product `hotel`, for the
   * installation id the Admin Panel returned; otherwise nothing is stored.
   *
   * The whole attempt runs in one transaction holding an advisory lock, so
   * concurrent calls (same process or another API instance) are serialised:
   * the second sees the first's row and never spends a code.
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

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ACTIVATION_LOCK_KEY})`);
      // Checked before calling the Admin Panel so a second attempt never burns a code.
      if (await this.store.get(tx)) throw alreadyActivated();

      const pair = newInstallationKeyPair();
      const response = await this.callActivate(client, code.trim(), pair.publicKey);
      const { trusted, chain } = await this.trustKeySet(client, rootKeySet, response.keySet);

      const evaluation = evaluateLicense({
        envelope: response.license,
        installationId: response.installationId,
        keySet: trusted,
        memory: { ...EMPTY_MEMORY },
        now: (this.config.now ?? (() => new Date()))(),
      });
      if (evaluation.state === 'INVALID') {
        this.logger.warn(`Activation licence refused: ${evaluation.reason}`);
        throw rejected(evaluation.reason);
      }
      if (evaluation.payload.product !== PRODUCT) {
        this.logger.warn(`Activation licence is for product "${evaluation.payload.product}"`);
        throw rejected('wrong_product');
      }
      if (evaluation.state !== 'VALID' && evaluation.state !== 'GRACE') {
        this.logger.warn(`Activation licence refused: ${evaluation.state}`);
        throw rejected(evaluation.state.toLowerCase());
      }

      await this.store.saveActivation(
        {
          installationId: response.installationId,
          privateSeedEnc: secretBox.seal(pair.seed),
          envelope: response.license,
          keySet: trusted,
          keyChain: chain,
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

  private async callActivate(
    client: CentralAdminClient,
    code: string,
    publicKey: string,
  ): Promise<ActivationResponse> {
    try {
      return await client.activate(code, publicKey);
    } catch (err) {
      if (err instanceof ParentRefusal) throw new DomainError(err.code, err.message, err.status);
      if (err instanceof ParentUnavailable) {
        throw new DomainError(
          'central_admin_unavailable',
          'Centralni admin trenutno nije dostupan. Aktivacioni kod je možda još važeći; pokušajte ponovo.',
          503,
        );
      }
      this.logger.error(`Activation call failed unexpectedly: ${(err as Error)?.message}`);
      throw err;
    }
  }

  /**
   * The key set from the activation response must chain from the pinned root
   * (SPEC 5.1). The Admin Panel returns only its latest set, which after two or
   * more rotations is signed by a key the root does not hold, so on
   * `unknown_key` the published chain is walked from the root and the response
   * set is checked again against where the walk ended. `stale_keyset` (an
   * authentic set no newer than what is trusted, e.g. the root itself before
   * any rotation) adds nothing and is not an error. Any other refusal is 422.
   *
   * Returns the trusted set and the signed sets accepted after the root, in order.
   */
  private async trustKeySet(
    client: CentralAdminClient,
    root: KeySet,
    offered: SignedKeySet,
  ): Promise<{ trusted: KeySet; chain: SignedKeySet[] }> {
    let trusted = root;
    const chain: SignedKeySet[] = [];
    let acceptance = acceptKeySet(offered, trusted);
    if (!acceptance.ok && acceptance.reason === 'unknown_key') {
      const walked = await this.walkKeyChain(client, trusted);
      trusted = walked.trusted;
      chain.push(...walked.accepted);
      // The offered set is normally the newest one the walk just accepted.
      // Re-checking it against the set it produced is not "stale" but
      // unknown_key (its signer is end-dated there), so recognise it by identity.
      if (walked.accepted.some((set) => sameSignedSet(set, offered))) return { trusted, chain };
      acceptance = acceptKeySet(offered, trusted);
    }
    if (acceptance.ok) {
      chain.push(offered);
      return { trusted: acceptance.keySet, chain };
    }
    if (acceptance.reason === 'stale_keyset') return { trusted, chain };
    this.logger.warn(`Activation key set refused: ${acceptance.reason}`);
    throw rejected(`keyset_${acceptance.reason}`);
  }

  /**
   * Walks `GET /v1/keys?since=` one accepted set at a time. Stops at the first
   * set that is refused for any reason other than stale, or when a page brings
   * nothing new. A network failure ends the walk with what was accepted so far;
   * the caller then refuses the offered set if it still does not chain.
   */
  private async walkKeyChain(
    client: CentralAdminClient,
    start: KeySet,
  ): Promise<{ trusted: KeySet; accepted: SignedKeySet[] }> {
    let trusted = start;
    const accepted: SignedKeySet[] = [];
    try {
      for (let page = 0; page < MAX_KEY_PAGES; page++) {
        const sets = await client.keySetsSince(trusted.issued_at);
        let progressed = false;
        let refused = false;
        for (const set of sets) {
          const acceptance = acceptKeySet(set, trusted);
          if (acceptance.ok) {
            trusted = acceptance.keySet;
            accepted.push(set);
            progressed = true;
          } else if (acceptance.reason !== 'stale_keyset') {
            this.logger.warn(`Key set in the published chain refused: ${acceptance.reason}`);
            refused = true;
            break;
          }
        }
        if (!progressed || refused) break;
      }
    } catch (err) {
      if (!(err instanceof ParentUnavailable || err instanceof ParentRefusal)) throw err;
      this.logger.warn(`Could not fetch newer key sets: ${err.message}`);
    }
    return { trusted, accepted };
  }
}
