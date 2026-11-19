"""Tests for claude-sub. The end-to-end tests drive real tmux with a fake `claude` script."""
import importlib.machinery, importlib.util, json, os, shutil, subprocess, sys, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(os.path.dirname(HERE), "bin", "claude-sub")
loader = importlib.machinery.SourceFileLoader("claude_sub", BIN)
spec = importlib.util.spec_from_loader("claude_sub", loader)
cs = importlib.util.module_from_spec(spec)
loader.exec_module(cs)

FAKE = r"""#!/bin/bash
case "$1" in
  --version) echo "${FAKE_VERSION:-2.1.330} (Claude Code)"; exit 0 ;;
  agents) echo '[]'; exit 0 ;;
esac
echo "ARGS=$*"
echo "CODE_MODE=${CLAUDE_CODE_EXPERIMENTAL_CODE_MODE:-unset} CLAUDECODE=${CLAUDECODE:-unset}"
echo "SUB_NAME=${CLAUDE_SUB_NAME:-unset} SUB_PARENT=${CLAUDE_SUB_PARENT:-unset}"
case "${FAKE_MODE:-on}" in
  confirm)
    echo "  ❯ No, start without it"; echo "    Yes, turn on Code Mode"
    while IFS= read -rsn1 k; do [ -z "$k" ] && break; done ;;
  unavailable)
    echo "⚠ Code Mode (experimental) isn't available · it only works with Opus 5.5, Sonnet 5.5 and later models"
    sleep 300; exit 0 ;;
  trust)
    echo "  ❯ No, exit"; echo "    Yes, I trust this folder"; sleep 300; exit 0 ;;
esac
echo "⚠ Code Mode (experimental) is on · this session can be resumed only with Code Mode on"
echo "❯ "
sleep 300
"""


class Unit(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(cs.classify("x\n⚠ Code Mode (experimental) is on · resumed")[0], "on")
        self.assertEqual(cs.classify("❯ No\n  Yes, turn on Code Mode")[0], "confirm")
        self.assertEqual(cs.classify("Yes, I trust this folder")[0], "trust")
        st, why = cs.classify("Code Mode (experimental) isn't available · it doesn't work in background jobs   │")
        self.assertEqual(st, "unavailable")
        self.assertIn("background jobs", why)
        self.assertEqual(cs.classify("")[0], "starting")

    def test_parse_version(self):
        self.assertEqual(cs.parse_version("2.1.327 (Claude Code)"), (2, 1, 327))
        self.assertIsNone(cs.parse_version("nothing"))
        self.assertTrue(cs.parse_version("2.1.322") < cs.MIN_CLAUDE <= cs.parse_version("2.1.323"))

    def test_default_name(self):
        self.assertEqual(cs.default_name("/a/My Folder", []), "sub-My-Folder")
        self.assertEqual(cs.default_name("/a/x", ["sub-x"]), "sub-x-2")
        self.assertEqual(cs.default_name("/a/x", ["sub-x", "sub-x-2"]), "sub-x-3")
        self.assertTrue(cs.NAME_RE.match(cs.default_name("/a/çã ~!", [])))

    def test_owner_pid_needs_a_live_session(self):
        cfg = tempfile.mkdtemp()
        os.makedirs(os.path.join(cfg, "sessions"))
        old = dict(os.environ)
        try:
            os.environ.update(CLAUDE_CONFIG_DIR=cfg, CLAUDE_PID="4242")
            self.assertIsNone(cs.owner_pid())   # stale: no session file for 4242
            open(os.path.join(cfg, "sessions", "4242.json"), "w").close()
            self.assertEqual(cs.owner_pid(), 4242)
        finally:
            os.environ.clear()
            os.environ.update(old)
            shutil.rmtree(cfg, ignore_errors=True)

    def test_clean_env(self):
        env = cs.clean_env({"CLAUDECODE": "1", "CLAUDE_AGENT_SDK_X": "1", "PATH": "/bin", "HOME": "/h",
                            "CLAUDE_CODE_MESSAGING_SOCKET": "s", "CLAUDE_SUB_PARENT": "1", "CLAUDE_SUB_NAME": "x"})
        self.assertEqual(env, {"PATH": "/bin", "HOME": "/h"})

    def test_unset_snippet_runs(self):
        env = {"PATH": os.environ.get("PATH", "/bin:/usr/bin"), "CLAUDECODE": "1", "CLAUDE_PREVIEW_Y": "2"}
        out = subprocess.run(["sh", "-c", cs.unset_snippet() + 'echo "[$CLAUDECODE][$CLAUDE_PREVIEW_Y]"'],
                             env=env, capture_output=True, text=True).stdout
        self.assertEqual(out.strip(), "[][]")

    def test_names_rejected(self):
        for bad in ["", "-x", "a b", "a/b", "x" * 65, "a;b"]:
            self.assertFalse(cs.NAME_RE.match(bad), bad)


@unittest.skipUnless(shutil.which("tmux"), "tmux not installed")
class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.bin = os.path.join(self.tmp, "bin")
        os.mkdir(self.bin)
        with open(os.path.join(self.bin, "claude"), "w") as f:
            f.write(FAKE)
        os.chmod(os.path.join(self.bin, "claude"), 0o755)
        self.folder = os.path.join(self.tmp, "proj")
        os.mkdir(self.folder)
        self.sock = f"claude-sub-test-{os.getpid()}-{int(time.time() * 1000) % 100000}"
        # A config folder of the test's own: no session file, so no parent unless a test adds one.
        self.cfg = os.path.join(self.tmp, "cfg")
        os.makedirs(os.path.join(self.cfg, "sessions"))
        self.env = dict(os.environ, PATH=self.bin + os.pathsep + os.environ["PATH"],
                        CLAUDE_SUB_SOCKET=self.sock, CLAUDE_SUB_TIMEOUT="15", CLAUDECODE="1",
                        CLAUDE_CONFIG_DIR=self.cfg)
        self.env.pop("CLAUDE_PID", None)
        # Never the tmux the tests run in: a tab would open in the developer's own session.
        self.env.pop("TMUX", None)
        self.env.pop("TMUX_PANE", None)

    def tearDown(self):
        subprocess.run(["tmux", "-L", self.sock, "kill-server"], capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_cli(self, *args, **extra):
        env = dict(self.env, **extra)
        return subprocess.run([sys.executable, BIN, *args], env=env, capture_output=True, text=True, timeout=60)

    def screen(self, name):
        return self.run_cli("screen", name).stdout

    def test_start_list_stop(self):
        r = self.run_cli("start", self.folder, "--model", "sonnet")
        self.assertEqual(r.returncode, 0, r.stderr)
        info = json.loads(r.stdout)
        self.assertEqual(info["name"], "sub-proj")
        self.assertEqual(info["codeMode"], "on")
        scr = self.screen("sub-proj")
        self.assertIn("CODE_MODE=1 CLAUDECODE=unset", scr)   # Code Mode set, parent session vars removed
        self.assertIn("ARGS=--name sub-proj --model sonnet", scr)
        # Started outside any session (no CLAUDE_PID, no session file above): a name, no parent.
        self.assertIn("SUB_NAME=sub-proj SUB_PARENT=unset", scr)
        rows = json.loads(self.run_cli("list").stdout)
        self.assertEqual([x["name"] for x in rows], ["sub-proj"])
        r = self.run_cli("stop", "sub-proj")
        self.assertEqual(json.loads(r.stdout), {"stopped": ["sub-proj"], "left": []})

    def test_start_records_the_owner_session(self):
        with open(os.path.join(self.cfg, "sessions", "4242.json"), "w") as f:
            f.write("{}")
        r = self.run_cli("start", self.folder, "--name", "owned", CLAUDE_PID="4242")
        self.assertEqual(r.returncode, 0, r.stderr)
        o = subprocess.run(["tmux", "-L", self.sock, "show-options", "-v", "-t", "=owned:", "@parent"],
                           capture_output=True, text=True)
        self.assertEqual(o.stdout.strip(), "4242")
        # The band's format reads it back per pane.
        o = subprocess.run(["tmux", "-L", self.sock, "list-panes", "-a", "-F", "#{session_name} #{@parent}"],
                           capture_output=True, text=True)
        self.assertIn("owned 4242", o.stdout)
        # The subsession's own process knows its name and the session that started it.
        self.assertIn("SUB_NAME=owned SUB_PARENT=4242", self.screen("owned"))

    def test_limit_and_duplicate(self):
        self.assertEqual(self.run_cli("start", self.folder, "--name", "a").returncode, 0)
        r = self.run_cli("start", self.folder, "--name", "a", CLAUDE_SUB_MAX="3")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("already runs", r.stderr)
        r = self.run_cli("start", self.folder, "--name", "b", CLAUDE_SUB_MAX="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("limit is 1", r.stderr)

    def test_confirm_needs_yes(self):
        r = self.run_cli("start", self.folder, FAKE_MODE="confirm")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("--yes", r.stderr)
        self.assertEqual(json.loads(self.run_cli("list").stdout), [])   # cleaned up

    def test_confirm_with_yes(self):
        r = self.run_cli("start", self.folder, "--yes", FAKE_MODE="confirm")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("is on", self.screen("sub-proj"))

    def test_unavailable_and_trust(self):
        r = self.run_cli("start", self.folder, FAKE_MODE="unavailable")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("Opus 5.5", r.stderr)
        r = self.run_cli("start", self.folder, FAKE_MODE="trust")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("trust", r.stderr)
        self.assertEqual(json.loads(self.run_cli("list").stdout), [])

    def test_old_version(self):
        r = self.run_cli("start", self.folder, FAKE_VERSION="2.1.300")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("claude update", r.stderr)

    # --- the tab in the starting session's own tmux ---------------------------------------------
    # A throwaway "user" tmux server stands in for the user's: a session with one window, like the
    # session claude-auto-retry makes, and TMUX/TMUX_PANE pointing at it as a session inside it sees.

    def user_tmux(self):
        self.outer = self.sock + "-user"
        self.addCleanup(subprocess.run, ["tmux", "-L", self.outer, "kill-server"], capture_output=True)
        subprocess.run(["tmux", "-L", self.outer, "-f", "/dev/null", "new-session", "-d", "-s", "main",
                        "-x", "120", "-y", "40", "sleep 300"], check=True)
        # zsh as the shell tmux runs the tab's command with, where there is one: it expands a bare "=word".
        if shutil.which("zsh"):
            self.outer_q("set-option", "-g", "default-shell", shutil.which("zsh"))
        o = self.outer_q("display-message", "-p", "-t", "=main:", "#{socket_path},#{pid},0 #{pane_id}").split()
        return {"TMUX": o[0], "TMUX_PANE": o[1]}, o[1]

    def outer_q(self, *args):
        return subprocess.run(["tmux", "-L", self.outer, *args], capture_output=True, text=True).stdout.strip()

    def windows(self):
        out = self.outer_q("list-windows", "-t", "=main", "-F", "#{window_id}|#{window_name}|#{@claude-sub}|#{window_active}")
        return [l.split("|") for l in out.splitlines()]

    def wait_for(self, cond, secs=10):
        end = time.time() + secs
        while time.time() < end:
            if cond():
                return True
            time.sleep(0.2)
        return cond()

    def test_tab_opens_in_the_user_session_and_closes_on_stop(self):
        env, pane = self.user_tmux()
        r = self.run_cli("start", self.folder, "--name", "tabbed", CLAUDE_SUB_TAB_PREFIX="sub:", **env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(json.loads(r.stdout)["tab"])
        w = self.windows()
        self.assertEqual(len(w), 2, w)
        main, tab = w
        self.assertEqual(tab[1:3], ["sub:tabbed", "tabbed"])
        self.assertEqual(main[3], "1")   # the user's window kept the focus (new-window -d)
        self.assertEqual(tab[3], "0")
        # The tab shows the subsession's conversation (a tmux client attached to it, no inner bar).
        self.assertTrue(self.wait_for(lambda: "is on" in self.outer_q("capture-pane", "-p", "-t", tab[0])),
                        self.outer_q("capture-pane", "-p", "-t", tab[0]))
        self.assertEqual(subprocess.run(["tmux", "-L", self.sock, "show-options", "-v", "-t", "=tabbed:", "status"],
                                        capture_output=True, text=True).stdout.strip(), "off")
        # The pane id claude-auto-retry types into ($TMUX_PANE of the main session) is unchanged.
        self.assertEqual(self.outer_q("display-message", "-p", "-t", pane, "#{window_id}"), main[0])
        # list and the other commands still work.
        self.assertEqual([x["name"] for x in json.loads(self.run_cli("list").stdout)], ["tabbed"])
        r = self.run_cli("stop", "tabbed")
        self.assertEqual(json.loads(r.stdout), {"stopped": ["tabbed"], "left": []})
        self.assertTrue(self.wait_for(lambda: len(self.windows()) == 1), self.windows())
        self.assertEqual(self.windows()[0][0], main[0])

    def test_mouse_click_switches_to_the_tab_and_back(self):
        # A real client attached to the "user" session, inside a driver tmux that types mouse clicks
        # (SGR sequences) into it, as a terminal would. The bar is laid out as "[0][1]" on the last row.
        env, _ = self.user_tmux()
        for o in (("mouse", "on"), ("status-left", ""), ("status-right", ""), ("window-status-format", "[#I]"),
                  ("window-status-current-format", "[#I]"), ("window-status-separator", "")):
            self.outer_q("set-option", "-g", *o)
        self.assertEqual(self.run_cli("start", self.folder, "--name", "clicky", **env).returncode, 0)
        drv = self.sock + "-drv"
        self.addCleanup(subprocess.run, ["tmux", "-L", drv, "kill-server"], capture_output=True)
        subprocess.run(["tmux", "-L", drv, "-f", "/dev/null", "new-session", "-d", "-s", "d", "-x", "60", "-y", "20",
                        f"unset TMUX; exec tmux -L {self.outer} attach-session -t main"], check=True)
        # No bar of the driver's own: the attached client gets all 20 rows, the user's bar is row 20.
        subprocess.run(["tmux", "-L", drv, "set-option", "-g", "status", "off"], check=True)
        active = lambda: self.outer_q("display-message", "-p", "-t", "=main:", "#{window_index}")
        screen = lambda: "active=" + active() + "\n" + subprocess.run(
            ["tmux", "-L", drv, "capture-pane", "-p", "-t", "d:"], capture_output=True, text=True).stdout

        def click(x, y=20):
            subprocess.run(["tmux", "-L", drv, "send-keys", "-t", "d:", "-l", f"\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m"])

        self.assertTrue(self.wait_for(lambda: "[0][1]" in screen()), screen())
        self.assertEqual(active(), "0")
        click(5)                                   # the subsession's tab
        self.assertTrue(self.wait_for(lambda: active() == "1"), screen())
        self.assertTrue(self.wait_for(lambda: "is on" in screen()), screen())   # its conversation shows
        self.assertIn("[0][1]", screen())          # the user's bar stays; no second bar inside
        click(10, 5)                               # a click inside the conversation does not trap the mouse
        time.sleep(0.8)   # past tmux's double-click time: two quick clicks are a double click (no status binding)
        click(2)                                   # back to the main window
        self.assertTrue(self.wait_for(lambda: active() == "0"), screen())

    def test_tab_closes_when_the_subsession_dies(self):
        env, _ = self.user_tmux()
        self.assertEqual(self.run_cli("start", self.folder, "--name", "dies", **env).returncode, 0)
        self.assertTrue(self.wait_for(lambda: len(self.windows()) == 2), self.windows())
        # Killed from outside claude-sub (crash, kill-session): the attached client exits, so does the tab.
        subprocess.run(["tmux", "-L", self.sock, "kill-session", "-t", "=dies"], check=True)
        self.assertTrue(self.wait_for(lambda: len(self.windows()) == 1), self.windows())

    def test_no_tab_outside_tmux_or_when_off(self):
        env, _ = self.user_tmux()
        r = self.run_cli("start", self.folder, "--name", "plain")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(json.loads(r.stdout)["tab"])
        r = self.run_cli("start", self.folder, "--name", "off", CLAUDE_SUB_TAB="0", **env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(json.loads(r.stdout)["tab"])
        self.assertEqual(len(self.windows()), 1)

    def test_missing_folder_and_unknown_name(self):
        self.assertIn("folder not found", self.run_cli("start", os.path.join(self.tmp, "nope")).stderr)
        self.assertIn("no subsession", self.run_cli("stop", "ghost").stderr)
        self.assertIn("no subsession", self.run_cli("screen", "ghost").stderr)


if __name__ == "__main__":
    unittest.main()
