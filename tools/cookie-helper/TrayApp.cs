using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal sealed class CookieHelper : Form
{
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly NotifyIcon tray = new NotifyIcon();
    readonly ComboBox browser = new ComboBox();
    readonly NumericUpDown interval = new NumericUpDown();
    readonly TextBox output = new TextBox(), host = new TextBox(), user = new TextBox(), identity = new TextBox();
    readonly NumericUpDown port = new NumericUpDown();
    readonly CheckBox enabled = new CheckBox(), sync = new CheckBox(), startup = new CheckBox();
    readonly Label status = new Label(), timestamps = new Label();
    readonly Button save = new Button(), signIn = new Button(), refresh = new Button(), cancel = new Button();
    readonly List<Control> settings = new List<Control>();
    readonly string node, worker, directory;
    readonly bool startHidden, smoke;
    readonly Icon normalIcon = MakeIcon(Color.FromArgb(209, 43, 43));
    readonly Icon workingIcon = MakeIcon(Color.FromArgb(42, 116, 187));
    readonly Icon warningIcon = MakeIcon(Color.FromArgb(195, 125, 16));
    readonly System.Windows.Forms.Timer smokeTimer = new System.Windows.Forms.Timer();
    Process backend;
    bool quitting, loaded, signingIn, gotStatus, failed;
    string lastNotification = "";

    [STAThread]
    static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        string node = null, worker = null, data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Helltube", "CookieHelper");
        bool hidden = false, smoke = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--node" && i + 1 < args.Length) node = args[++i];
            else if (args[i] == "--worker" && i + 1 < args.Length) worker = args[++i];
            else if (args[i] == "--data" && i + 1 < args.Length) data = args[++i];
            else if (args[i] == "--hidden") hidden = true;
            else if (args[i] == "--smoke-test") smoke = true;
        }
        if (node == null || worker == null) {
            try {
                var launch = new JavaScriptSerializer().Deserialize<Dictionary<string, string>>(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "launcher.json")));
                node = launch["node"]; worker = launch["worker"];
            } catch { MessageBox.Show("Launch with npm run cookie-helper from the Helltube checkout.", "Helltube Cookie Helper"); return 1; }
        }
        string sid = WindowsIdentity.GetCurrent().User.Value;
        bool created;
        using (var mutex = new Mutex(true, "Local\\HelltubeCookieHelper-" + sid + (smoke ? "-smoke" : ""), out created))
        {
            if (!created) { MessageBox.Show("Cookie Helper is already running. Open Settings from its tray icon.", "Helltube Cookie Helper"); return 0; }
            try
            {
                Directory.CreateDirectory(data);
                if ((File.GetAttributes(data) & FileAttributes.ReparsePoint) != 0) throw new IOException();
                var acl = new DirectorySecurity();
                acl.SetAccessRuleProtection(true, false);
                acl.SetOwner(WindowsIdentity.GetCurrent().User);
                foreach (string account in new[] { sid, "S-1-5-18" })
                    acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(account), FileSystemRights.FullControl,
                        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                Directory.SetAccessControl(data, acl);
                using (var form = new CookieHelper(node, worker, data, hidden, smoke)) { Application.Run(form); return form.failed ? 1 : 0; }
            }
            catch { MessageBox.Show("Could not start the helper. Check that Node.js, npm dependencies and the local data folder are available.", "Helltube Cookie Helper", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
            finally { mutex.ReleaseMutex(); }
        }
    }

    CookieHelper(string nodePath, string workerPath, string dataPath, bool hidden, bool smokeTest)
    {
        node = nodePath; worker = workerPath; directory = dataPath; startHidden = hidden; smoke = smokeTest;
        Text = "Helltube Cookie Helper";
        Font = new Font("Segoe UI", 10);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(690, 665);
        MinimumSize = new Size(706, 704);
        StartPosition = FormStartPosition.CenterScreen;
        Icon = normalIcon;
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(22), ColumnCount = 3, RowCount = 15, AutoScroll = true };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 155));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
        Controls.Add(layout);
        var title = new Label { Text = "YouTube cookies, kept current", AutoSize = true, Font = new Font("Segoe UI", 16, FontStyle.Bold), Margin = new Padding(0, 0, 0, 12) };
        layout.Controls.Add(title, 0, 0); layout.SetColumnSpan(title, 3);
        var description = new Label { Text = "Sign in once in a dedicated browser profile. The helper refreshes your\nYouTube session and saves a private cookies file while you are logged in.", AutoSize = true, Margin = new Padding(0, 0, 0, 16) };
        layout.Controls.Add(description, 0, 1); layout.SetColumnSpan(description, 3);
        browser.DropDownStyle = ComboBoxStyle.DropDownList; browser.Items.AddRange(new object[] { "Microsoft Edge", "Google Chrome" });
        AddRow(layout, 2, "Browser", browser, null);
        interval.Minimum = 15; interval.Maximum = 10080;
        AddRow(layout, 3, "Refresh (minutes)", interval, null);
        enabled.Text = "Refresh automatically"; enabled.AutoSize = true;
        layout.Controls.Add(enabled, 1, 4); layout.SetColumnSpan(enabled, 2); settings.Add(enabled);
        var browseOutput = new Button { Text = "Browse", AutoSize = true };
        browseOutput.Click += delegate { using (var dialog = new SaveFileDialog { Filter = "Cookies file (*.txt)|*.txt", FileName = output.Text, OverwritePrompt = true }) if (dialog.ShowDialog(this) == DialogResult.OK) output.Text = dialog.FileName; };
        AddRow(layout, 5, "Cookies file", output, browseOutput);
        sync.Text = "Sync to Helltube over SSH"; sync.AutoSize = true;
        layout.Controls.Add(sync, 1, 6); layout.SetColumnSpan(sync, 2); settings.Add(sync);
        AddRow(layout, 7, "SSH host", host, null);
        AddRow(layout, 8, "SSH username", user, null);
        port.Minimum = 1; port.Maximum = 65535; port.Value = 22;
        AddRow(layout, 9, "SSH port", port, null);
        var browseKey = new Button { Text = "Browse", AutoSize = true };
        browseKey.Click += delegate { using (var dialog = new OpenFileDialog { Title = "Choose an SSH private key (optional with ssh-agent)" }) if (dialog.ShowDialog(this) == DialogResult.OK) identity.Text = dialog.FileName; };
        AddRow(layout, 10, "SSH key (optional)", identity, browseKey);
        var sshHelp = new Label { Text = "SSH needs key login and the server importer (see helper README).\nEach sync restarts a running Helltube server to load the new cookies.", AutoSize = true, ForeColor = Color.DimGray, Margin = new Padding(3, 3, 0, 12) };
        layout.Controls.Add(sshHelp, 1, 11); layout.SetColumnSpan(sshHelp, 2);
        startup.Text = "Start in tray when I sign in to Windows"; startup.AutoSize = true;
        layout.Controls.Add(startup, 1, 12); layout.SetColumnSpan(startup, 2); settings.Add(startup);
        using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) startup.Checked = key != null && key.GetValue("HelltubeCookieHelper") != null;
        var actions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 14, 0, 10) };
        save.Text = "Save settings"; signIn.Text = "Sign in"; refresh.Text = "Refresh now"; cancel.Text = "Cancel sign-in";
        foreach (var button in new[] { save, signIn, refresh, cancel }) { button.AutoSize = true; button.Enabled = false; actions.Controls.Add(button); }
        cancel.Visible = false;
        save.Click += delegate { SaveSettings(); };
        signIn.Click += delegate { Send("signIn"); };
        refresh.Click += delegate { Send("refresh"); };
        cancel.Click += delegate { Send("cancel"); };
        layout.Controls.Add(actions, 0, 13); layout.SetColumnSpan(actions, 3);
        var information = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, AutoSize = true, Dock = DockStyle.Fill, WrapContents = false };
        status.Text = "Starting helper..."; status.AutoSize = true; status.MaximumSize = new Size(625, 0);
        timestamps.AutoSize = true; timestamps.ForeColor = Color.DimGray;
        information.Controls.Add(status); information.Controls.Add(timestamps);
        layout.Controls.Add(information, 0, 14); layout.SetColumnSpan(information, 3);
        var menu = new ContextMenuStrip();
        menu.Items.Add("Settings", null, delegate { ShowSettings(); });
        menu.Items.Add("Refresh now", null, delegate { Send("refresh"); });
        menu.Items.Add("Sign in to YouTube", null, delegate { ShowSettings(); Send("signIn"); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, delegate { Quit(); });
        tray.Icon = normalIcon; tray.Text = "Helltube Cookie Helper"; tray.ContextMenuStrip = menu; tray.Visible = true;
        tray.DoubleClick += delegate { ShowSettings(); };
        FormClosing += delegate(object sender, FormClosingEventArgs e) {
            if (!quitting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); }
        };
        FormClosed += delegate { tray.Visible = false; tray.Dispose(); smokeTimer.Dispose(); normalIcon.Dispose(); workingIcon.Dispose(); warningIcon.Dispose(); if (backend != null) backend.Dispose(); };
        Shown += delegate {
            try { StartBackend(); }
            catch { failed = true; status.Text = "Cannot start Node.js. Relaunch with npm run cookie-helper to repair the launcher paths."; tray.Icon = warningIcon; }
            if (startHidden) Hide();
            if (smoke) {
                smokeTimer.Interval = 10000;
                smokeTimer.Tick += delegate {
                    smokeTimer.Stop();
                    failed = failed || !gotStatus;
                    using (var bitmap = new Bitmap(Width, Height)) { DrawToBitmap(bitmap, new Rectangle(0, 0, Width, Height)); bitmap.Save(Path.Combine(directory, "smoke.png")); }
                    failed = failed || browser.SelectedIndex < 0;
                    File.WriteAllText(Path.Combine(directory, "smoke-result.json"), json.Serialize(new { ok = !failed, message = status.Text, browser = browser.SelectedItem }));
                    Quit();
                };
                smokeTimer.Start();
            }
        };
    }

    void AddRow(TableLayoutPanel layout, int row, string label, Control control, Button browse)
    {
        layout.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 0, 6) }, 0, row);
        control.Dock = DockStyle.Fill; control.Margin = new Padding(3, 4, 3, 4); layout.Controls.Add(control, 1, row); settings.Add(control);
        if (browse != null) { layout.Controls.Add(browse, 2, row); settings.Add(browse); } else layout.SetColumnSpan(control, 2);
    }

    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);
    static Icon MakeIcon(Color color)
    {
        using (var bitmap = new Bitmap(32, 32))
        using (var graphics = Graphics.FromImage(bitmap))
        using (var brush = new SolidBrush(color))
        {
            graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            graphics.FillEllipse(brush, 1, 1, 30, 30);
            graphics.FillPolygon(Brushes.White, new[] { new Point(12, 8), new Point(12, 24), new Point(24, 16) });
            var handle = bitmap.GetHicon();
            try { using (var icon = Icon.FromHandle(handle)) return (Icon)icon.Clone(); }
            finally { DestroyIcon(handle); }
        }
    }

    static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"").TrimEnd('\\') + "\""; }
    void ShowSettings() { Show(); WindowState = FormWindowState.Normal; Activate(); }

    void StartBackend()
    {
        backend = new Process { StartInfo = new ProcessStartInfo(node, Quote(worker) + " " + Quote(directory)) {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true,
            RedirectStandardError = true, WorkingDirectory = Path.GetDirectoryName(worker)
        }, EnableRaisingEvents = true };
        backend.StartInfo.EnvironmentVariables.Remove("DEBUG");
        backend.StartInfo.EnvironmentVariables.Remove("PWDEBUG");
        backend.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
            if (e.Data != null && !IsDisposed && IsHandleCreated) try { BeginInvoke(new Action(() => Receive(e.Data))); } catch (InvalidOperationException) {}
        };
        // Never display raw browser/SSH diagnostics: they can contain account material.
        backend.ErrorDataReceived += delegate { };
        backend.Exited += delegate {
            if (!IsDisposed && IsHandleCreated) try { BeginInvoke(new Action(() => {
                if (quitting) Close();
                else { if (!failed) status.Text = "The helper stopped. Quit and reopen it to retry."; failed = true; tray.Icon = SystemIcons.Error; save.Enabled = signIn.Enabled = refresh.Enabled = cancel.Enabled = false; }
            })); } catch (InvalidOperationException) {}
        };
        backend.Start(); backend.BeginOutputReadLine(); backend.BeginErrorReadLine();
    }

    void Send(string action) { Send(new Dictionary<string, object> { { "action", action } }); }
    void Send(Dictionary<string, object> message)
    {
        try { if (backend != null && !backend.HasExited) { backend.StandardInput.WriteLine(json.Serialize(message)); backend.StandardInput.Flush(); } }
        catch { status.Text = "Cannot reach the helper. Quit and reopen it."; }
    }

    void SaveSettings()
    {
        var config = new Dictionary<string, object> {
            { "browser", browser.SelectedIndex == 1 ? "chrome" : "edge" }, { "intervalMinutes", (int)interval.Value },
            { "enabled", enabled.Checked }, { "output", output.Text.Trim() }, { "sshEnabled", sync.Checked },
            { "sshHost", host.Text.Trim() }, { "sshUser", user.Text.Trim() }, { "sshPort", (int)port.Value }, { "sshIdentity", identity.Text.Trim() }
        };
        Send(new Dictionary<string, object> { { "action", "save" }, { "config", config } });
    }

    void Receive(string line)
    {
        try
        {
            var message = json.Deserialize<Dictionary<string, object>>(line);
            string type = (string)message["type"];
            if (type == "config" || type == "saved")
            {
                var config = (Dictionary<string, object>)message["config"];
                browser.SelectedIndex = (string)config["browser"] == "chrome" ? 1 : 0;
                interval.Value = Convert.ToDecimal(config["intervalMinutes"]); enabled.Checked = (bool)config["enabled"];
                output.Text = (string)config["output"]; sync.Checked = (bool)config["sshEnabled"];
                host.Text = (string)config["sshHost"]; user.Text = (string)config["sshUser"]; port.Value = Convert.ToDecimal(config["sshPort"]); identity.Text = (string)config["sshIdentity"];
                loaded = true;
                if (type == "saved" && !smoke) {
                    try {
                        using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) {
                            if (startup.Checked) {
                                string command = Quote(Application.ExecutablePath) + " --hidden";
                                if (command.Length > 260) throw new IOException();
                                key.SetValue("HelltubeCookieHelper", command);
                            }
                            else key.DeleteValue("HelltubeCookieHelper", false);
                        }
                    } catch { MessageBox.Show(this, "Settings saved, but Windows startup could not be changed.", Text); }
                }
            }
            else if (type == "status")
            {
                gotStatus = true;
                bool busy = (bool)message["busy"], error = (bool)message["error"];
                signingIn = (bool)message["signingIn"];
                status.Text = (string)message["message"];
                status.ForeColor = error ? Color.Firebrick : SystemColors.ControlText;
                timestamps.Text = "Last export: " + FormatDate(message["lastExport"]) + "    Last sync: " + FormatDate(message["lastSync"]) +
                    "\nNext refresh: " + (message["nextRun"] == null ? "Paused" : DateTimeOffset.FromUnixTimeMilliseconds(Convert.ToInt64(message["nextRun"])).LocalDateTime.ToString("g")) +
                    "\nBrowser identity: " + (message.ContainsKey("browserIdentity") ? (string)message["browserIdentity"] : "Automatic Chrome version");
                tray.Icon = error ? warningIcon : busy ? workingIcon : normalIcon;
                tray.Text = error ? "Helltube cookies: attention needed" : busy ? "Helltube cookies: refreshing" : "Helltube Cookie Helper";
                foreach (var control in settings) control.Enabled = loaded && !busy && !signingIn;
                save.Enabled = loaded && !busy && !signingIn; signIn.Enabled = loaded && !busy;
                refresh.Enabled = loaded && !busy; refresh.Text = signingIn ? "Finish sign-in" : "Refresh now";
                cancel.Enabled = !busy; cancel.Visible = signingIn;
                if (error && status.Text != lastNotification && !smoke) { tray.ShowBalloonTip(6000, "YouTube cookies need attention", status.Text, ToolTipIcon.Warning); lastNotification = status.Text; }
                if (!error) lastNotification = "";
            }
            else if (type == "fatal") { failed = true; status.Text = (string)message["message"]; tray.Icon = SystemIcons.Error; }
        }
        catch { status.Text = "The helper returned an invalid response. Restart it to retry."; }
    }

    static string FormatDate(object value) { DateTime date; return value != null && DateTime.TryParse(value.ToString(), out date) ? date.ToLocalTime().ToString("g") : "Never"; }
    void Quit()
    {
        if (quitting) return;
        quitting = true;
        status.Text = "Finishing the current operation and closing...";
        Enabled = false;
        if (backend == null || backend.HasExited) Close();
        else { Send("quit"); backend.StandardInput.Close(); }
    }
}
