import { compose } from './global-setup'

export default function teardown(): void {
  compose('down', '-v')
}
