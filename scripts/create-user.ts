import bcrypt from 'bcryptjs'
import { getGlobalDb } from '../src/db/global-db.js'
import { createUser } from '../src/db/user-store.js'
import { displayNameSchema, newPasswordSchema } from '../src/lib/credentials.js'

const [rawName, rawPassword] = process.argv.slice(2)

if (!rawName || !rawPassword) {
  console.error('Usage: npm run user:create -- <displayName> <password>')
  process.exit(1)
}

const name = displayNameSchema.safeParse(rawName)
if (!name.success) {
  console.error('Display name must be 1 to 100 characters.')
  process.exit(1)
}
const password = newPasswordSchema.safeParse(rawPassword)
if (!password.success) {
  console.error('Password must be 8 to 72 characters.')
  process.exit(1)
}

const db = getGlobalDb()
const passwordHash = bcrypt.hashSync(password.data, 10)
const user = createUser(db, name.data, passwordHash)

console.log(`Created user "${user.displayName}" (id: ${user.id})`)
