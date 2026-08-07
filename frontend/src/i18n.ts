import { i18n } from '@lingui/core'
import { messages as en } from './locales/en.po'

i18n.load('en', en)
i18n.activate('en')

export { i18n }
