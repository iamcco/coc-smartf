import {Neovim, workspace} from 'coc.nvim'
import {getPositions} from './util'

const characters = [
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r',
  's', 't', 'u', 'v', 'w', 'x', 'y', 'z', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  ',', '.']

interface Character {
  position: [number, number]
  character: string
}

export default class Manager {
  private matchIds: number[] = []
  private positionMap: Map<string, Character> = new Map()
  private timeout: number
  private character: string
  private isForward = true
  private changeStart: number
  private jumpOnTrigger: boolean
  private wordJump: boolean
  private repeatPosition: [number, number]
  constructor(private nvim: Neovim) {
    let config = workspace.getConfiguration('smartf')
    this.timeout = config.get<number>('timeout', 1000)
    this.jumpOnTrigger = config.get<boolean>('jumpOnTrigger', true)
    this.wordJump = config.get<boolean>('wordJump', true)
  }

  public async forward(): Promise<void> {
    await this.jump()
  }

  public async backward(): Promise<void> {
    await this.jump(false)
  }

  public async repeat(): Promise<void> {
    await this.jump(this.isForward, this.character)
  }

  public async repeatOpposite(): Promise<void> {
    await this.jump(!this.isForward, this.character)
  }

  private async jump(isForward = true, character?: string): Promise<void> {
    let {nvim} = this
    this.positionMap.clear()
    nvim.pauseNotification()
    nvim.call('coc#util#cursor', [], true)
    nvim.call('line', ['w0'], true)
    nvim.call('getline', ['.'], true)
    nvim.call('eval', [`getline(line('w0'), line('w$'))`], true)
    nvim.command(`setl conceallevel=2`, true)
    let [res, err] = await nvim.resumeNotification()
    if (err) {
      workspace.showMessage(`Error on ${err[0]}: ${err[1]} - ${err[2]}`, 'error')
      return
    }
    let [cursor, startline, currline, lines] = res as [[number, number], number, string, string[]]
    if (!character) {
      character = await workspace.callAsync('coc#list#getchar', []) as string
      this.isForward = isForward
      this.character = character
    }
    let offset = 0
    // create new lines
    if (!isForward) {
      let count = cursor[0] - (startline - 1) + 1
      lines = lines.slice(0, count)
      lines[lines.length - 1] = currline.slice(0, cursor[1])
    } else {
      offset = cursor[1] + 1
      lines = lines.slice(cursor[0] - (startline - 1))
    }
    let positions = getPositions(character, lines, this.wordJump, offset)
    if (positions.length == 0) return
    if (!isForward) positions.reverse()
    // jump to first when necessary
    let currpos: [number, number]
    if (this.jumpOnTrigger) {
      let first = positions.shift()
      let col = byteIndex(lines[first.line], first.character) + 1
      let line = startline + first.line + (isForward ? cursor[0] + 1 - startline : 0)
      await nvim.call('cursor', [line, col])
      currpos = [line, col]
    } else {
      let [, line, col] = await nvim.call('getpos', ['.']) as number[]
      currpos = [line, col]
    }
    if (positions.length == 0) return
    this.positionMap.clear()
    let remains: [number, number][] = []
    for (let i = 0; i < positions.length; i++) {
      let pos = positions[i]
      let ch = characters[i]
      let line = startline + pos.line + (isForward ? cursor[0] + 1 - startline : 0)
      let col = byteIndex(lines[pos.line], pos.character) + 1
      if (ch) {
        this.positionMap.set(ch, {character: ch, position: [line, col]})
      } else {
        remains.push([line, col])
      }
    }
    this.repeatPosition = remains[0]
    // parse positions
    nvim.pauseNotification()
    nvim.command('silent doautocmd User SmartfEnter', true)
    for (let val of this.positionMap.values()) {
      let {position, character} = val
      let pos = [position[0], position[1], 1]
      nvim.call('matchaddpos', ['Conceal', [pos], 99, -1, {conceal: character}], true)
    }
    nvim.call('matchaddpos', ['Cursor', [[currpos[0], currpos[1], 1]], 99], true)
    for (let val of remains) {
      let pos = [val[0], val[1], 1]
      nvim.call('matchaddpos', ['Conceal', [pos], 99, -1, {conceal: ';'}], true)
    }
    let result = await nvim.resumeNotification()
    if (result[1]) return
    this.matchIds = result[0]
    this.getCharacter().catch(e => {
      // tslint:disable-next-line: no-console
      console.error(e)
    })
  }

  private async getCharacter(): Promise<void> {
    let p = workspace.callAsync('coc#list#getchar', [])
    let finished = false
    setTimeout(async () => {
      if (finished) return
      this.nvim.command(`call feedkeys("\\<esc>", 'in')`, true)
      await this.cancel()
    }, this.timeout || 1000)
    let ch = await p as string
    finished = true
    if (ch == ';' && this.repeatPosition) {
      await this.cancel()
      this.nvim.call('cursor', this.repeatPosition, true)
      this.jump(this.isForward, this.character).catch(_e => {
        // noop
      })
    } else {
      let val = this.positionMap.get(ch)
      await this.cancel()
      if (val) this.nvim.call('cursor', val.position, true)
    }
  }

  public async cancel(): Promise<void> {
    let {nvim, matchIds, changeStart} = this
    if (!matchIds.length) return
    nvim.pauseNotification()
    nvim.setVar('coc_smartf_activated', 0, true)
    nvim.command('silent doautocmd User SmartfLeave', true)
    nvim.call('coc#util#clearmatches', [this.matchIds], true)
    this.matchIds = []
    await nvim.resumeNotification()
  }
}

function characterIndex(content: string, byteIndex: number): number {
  let buf = Buffer.from(content, 'utf8')
  return buf.slice(0, byteIndex).toString('utf8').length
}

function byteIndex(content: string, index: number): number {
  let s = content.slice(0, index)
  return Buffer.byteLength(s)
}
