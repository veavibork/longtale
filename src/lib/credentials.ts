import { z } from 'zod'

/** Login name. One rule for login, rename and user creation, so no one can save a name they cannot log in with. */
export const displayNameSchema = z.string().trim().min(1).max(100)

/** bcrypt ignores input past 72 bytes. */
export const PASSWORD_MAX_LENGTH = 72

/** A password being set (user creation or change). Login accepts any stored password up to the max. */
export const newPasswordSchema = z.string().min(8).max(PASSWORD_MAX_LENGTH)
