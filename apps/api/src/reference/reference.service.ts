import { Injectable } from '@nestjs/common';
import { formatReference } from '@ruliba/shared';
import { sql } from 'drizzle-orm';
import { DbOrTx } from '../db/db';

/**
 * Issues the next reference number for a department + document type + year.
 * One SQL statement inserts the counter row or increments it under a row lock, so two documents
 * approved at the same moment can never get the same number. Call it inside the transaction that
 * marks the document approved: if that transaction fails, the number is not used up (no gaps).
 */
@Injectable()
export class ReferenceService {
  async next(tx: DbOrTx, departmentCode: string, typeCode: string, year = new Date().getFullYear()): Promise<string> {
    const res = await tx.execute<{ last_number: number }>(sql`
      INSERT INTO reference_sequences (department_code, type_code, year, last_number)
      VALUES (${departmentCode}, ${typeCode}, ${year}, 1)
      ON CONFLICT (department_code, type_code, year)
      DO UPDATE SET last_number = reference_sequences.last_number + 1
      RETURNING last_number`);
    return formatReference(departmentCode, typeCode, year, Number(res.rows[0].last_number));
  }
}
