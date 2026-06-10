#!/usr/bin/env python3
"""Round 2: robust submission; capture AskUserQuestion, subagent, deny, interrupt."""
import json, os, threading, time
import pexpect

CAPTURE = '/tmp/cue-hook-capture.jsonl'
TIMELINE = '/tmp/cue-state-timeline.jsonl'
SESSIONS = os.path.expanduser('~/Library/Application Support/Cue/sessions.json')
PROJ = '/tmp/cue-audit-proj'
stop_poller = False
SID = {'v': None}  # session id of THIS run, set from SessionStart

def mark(label):
    with open(TIMELINE, 'a') as f:
        f.write(json.dumps({"t": time.time(), "marker": label}) + "\n")
    print(f"[{time.strftime('%H:%M:%S')}] MARK {label}", flush=True)

def poller():
    last = None
    while not stop_poller:
        try:
            with open(SESSIONS) as f:
                data = json.load(f)
            sid = SID['v']
            if sid and sid in data.get('sessions', {}):
                s = data['sessions'][sid]
                snap = (s.get('state'), s.get('activeSubagents', 0))
                if snap != last:
                    last = snap
                    with open(TIMELINE, 'a') as f:
                        f.write(json.dumps({"t": time.time(), "state": s.get('state'),
                                            "subs": s.get('activeSubagents', 0)}) + "\n")
        except Exception:
            pass
        time.sleep(0.4)

def captured_events():
    evs = []
    try:
        with open(CAPTURE) as f:
            for line in f:
                try:
                    evs.append(json.loads(line))
                except Exception:
                    pass
    except FileNotFoundError:
        pass
    return evs

def wait_for(pred, timeout, label):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for e in captured_events():
            if pred(e):
                mark(f"observed:{label}")
                return e
        time.sleep(0.5)
    mark(f"TIMEOUT:{label}")
    return None

def ev_is(e, name, after=0.0, **kw):
    if not e['argv'] or e['argv'][0] != name:
        return False
    if e['t'] < after:
        return False
    if SID['v'] and e['payload'].get('session_id') not in (None, SID['v']):
        return False
    p = e.get('payload', {})
    return all(p.get(k) == v for k, v in kw.items())

def submit(child, text, label):
    """Type text, then Enter separately; verify UserPromptSubmit, retry Enter."""
    t0 = time.time()
    mark(f"{label}-type")
    child.send(text)
    time.sleep(1.5)
    child.send("\r")
    if wait_for(lambda e: ev_is(e, 'UserPromptSubmit', after=t0), 15, f"{label}-submitted"):
        return True
    child.send("\r")
    return bool(wait_for(lambda e: ev_is(e, 'UserPromptSubmit', after=t0), 15, f"{label}-submitted-retry"))

def main():
    env = dict(os.environ)
    for k in list(env):
        if k.startswith('CLAUDE'):
            del env[k]
    env['TERM'] = 'xterm-256color'
    threading.Thread(target=poller, daemon=True).start()

    spawn_t = time.time()
    mark('spawn2')
    child = pexpect.spawn(
        '/Users/dev/.local/bin/claude',
        ['--permission-mode', 'default', '--model', 'haiku',
         '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
        cwd=PROJ, env=env, dimensions=(40, 140), encoding='utf-8', timeout=10)
    log = open('/tmp/cue-audit-tui2.log', 'w')
    def drain():
        while child.isalive():
            try:
                log.write(child.read_nonblocking(size=4096, timeout=0.5)); log.flush()
            except pexpect.TIMEOUT:
                pass
            except (pexpect.EOF, OSError):
                break
    threading.Thread(target=drain, daemon=True).start()

    e = wait_for(lambda e: ev_is(e, 'SessionStart', after=spawn_t), 60, 'SessionStart2')
    if not e:
        child.terminate(force=True); return
    SID['v'] = e['payload'].get('session_id')
    mark(f"sid={SID['v']}")
    time.sleep(6)

    # ── Q1: AskUserQuestion ────────────────────────────────────────
    q1 = time.time()
    if submit(child, "Use the AskUserQuestion tool to ask me ONE question with two options about my favorite color. Do nothing else after I answer; just acknowledge.", 'Q1'):
        wait_for(lambda e: ev_is(e, 'PreToolUse', after=q1, tool_name='AskUserQuestion'), 60, 'Q1-asktool')
        mark('Q1-dialog-hold')
        time.sleep(12)
        mark('Q1-answer-enter')
        child.send("\r")
        wait_for(lambda e: ev_is(e, 'Stop', after=q1), 90, 'Q1-stop')
    time.sleep(3)

    # ── Q2: subagent ───────────────────────────────────────────────
    q2 = time.time()
    if submit(child, "Use the Agent tool with subagent_type Explore to launch ONE subagent that lists files here. Report briefly.", 'Q2'):
        wait_for(lambda e: ev_is(e, 'SubagentStart', after=q2), 120, 'Q2-SubagentStart')
        wait_for(lambda e: ev_is(e, 'SubagentStop', after=q2), 240, 'Q2-SubagentStop')
        wait_for(lambda e: ev_is(e, 'Stop', after=q2), 90, 'Q2-stop')
    time.sleep(3)

    # ── Q3: permission deny via ESC ────────────────────────────────
    q3 = time.time()
    if submit(child, "Run exactly this bash command and nothing else: touch brandnewfile3", 'Q3'):
        wait_for(lambda e: ev_is(e, 'Notification', after=q3, notification_type='permission_prompt')
                 or ev_is(e, 'PermissionRequest', after=q3), 60, 'Q3-perm')
        mark('Q3-dialog-hold')
        time.sleep(8)
        mark('Q3-ESC-deny')
        child.send("\x1b")
        time.sleep(10)
        mark('Q3-post-deny')

    # ── Q4: interrupt mid-generation ───────────────────────────────
    q4 = time.time()
    if submit(child, "Write a 600 word story about a lighthouse keeper. Do not use any tools.", 'Q4'):
        time.sleep(7)
        mark('Q4-ESC-interrupt')
        child.send("\x1b")
        time.sleep(12)
        mark('Q4-post-interrupt')

    # ── Q5: exit ───────────────────────────────────────────────────
    q5 = time.time()
    mark('Q5-exit')
    child.send("/exit")
    time.sleep(1.5)
    child.send("\r")
    wait_for(lambda e: ev_is(e, 'SessionEnd', after=q5), 30, 'SessionEnd2')
    time.sleep(2)
    try:
        child.terminate(force=True)
    except Exception:
        pass
    mark('done2')

if __name__ == '__main__':
    try:
        main()
    finally:
        globals()['stop_poller'] = True
        time.sleep(1)
