/*
 * xkeys — feeds keyboard events into an X display through XTest.
 *
 * The streaming server uses it to drive the game's controller 1 when the
 * runtime is built without its debug control port (production build): the
 * pad state becomes key presses on the runtime's default keyboard binds
 * (psx_keybinds.c: X=Cross, S=Circle, Z=Square, A=Triangle, Q/W/E/R =
 * L1/R1/L2/R2, Return=Start, Right Shift=Select, arrows).
 *
 * stdin, one command per line:  "d <keysym-name>" press, "u <keysym-name>"
 * release, "f <window-id>" give focus to a window.
 *   cc -O2 xkeys.c -o xkeys -lX11 -lXtst
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>

int main(void) {
    Display* d = XOpenDisplay(NULL);
    if (!d) { fprintf(stderr, "xkeys: cannot open display\n"); return 1; }
    int ev, err, maj, min;
    if (!XTestQueryExtension(d, &ev, &err, &maj, &min)) { fprintf(stderr, "xkeys: no XTest\n"); return 1; }
    char line[256];
    setvbuf(stdout, NULL, _IONBF, 0);
    while (fgets(line, sizeof line, stdin)) {
        char op = 0, arg[200] = {0};
        if (sscanf(line, " %c %199s", &op, arg) < 2) continue;
        if (op == 'f') {
            Window w = (Window)strtoul(arg, NULL, 0);
            XSetInputFocus(d, w, RevertToParent, CurrentTime);
            XRaiseWindow(d, w);
        } else if (op == 'd' || op == 'u') {
            KeySym ks = XStringToKeysym(arg);
            if (ks == NoSymbol) continue;
            KeyCode kc = XKeysymToKeycode(d, ks);
            if (!kc) continue;
            XTestFakeKeyEvent(d, kc, op == 'd', CurrentTime);
        }
        XFlush(d);
    }
    XCloseDisplay(d);
    return 0;
}
