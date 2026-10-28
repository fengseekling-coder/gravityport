/**
 * Type surface of lib/library-location.mjs consumed from TypeScript sources
 * (library-migration.ts). The .mjs module is plain JavaScript by design, so
 * this hand-maintained declaration keeps the shared migration-marker writer
 * typed without duplicating its logic.
 */

/** Filesystem-level proof that a library's SQLite initialization completed. */
export declare const SQLITE_MIGRATION_MARKER_FILE: string;
/** The SQLite database file name inside a library directory. */
export declare const LIBRARY_DATABASE_FILE: string;
/**
 * Write the migration-completed marker next to mosa.db, atomically, unless it
 * already exists. Returns false when the write failed; never throws.
 */
export declare function ensureSqliteMigrationMarker(libraryDir: string): boolean;
