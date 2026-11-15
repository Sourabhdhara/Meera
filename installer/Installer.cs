using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("MEERA Setup")]
[assembly: AssemblyProduct("MEERA Desktop AI Companion")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace MeeraInstaller
{
    public class InstallerForm : Form
    {
        private ProgressBar progressBar;
        private Label statusLabel;
        private Label titleLabel;
        private Label subTitleLabel;
        private Button actionButton;

        public InstallerForm()
        {
            this.Text = "MEERA AI Companion — Installer";
            this.Width = 460;
            this.Height = 260;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.BackColor = Color.FromArgb(10, 12, 18);
            this.ForeColor = Color.White;
            this.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            // Title
            titleLabel = new Label();
            titleLabel.Text = "MEERA AI COMPANION";
            titleLabel.Font = new Font("Segoe UI", 14f, FontStyle.Bold);
            titleLabel.ForeColor = Color.FromArgb(232, 121, 249);
            titleLabel.Location = new Point(24, 20);
            titleLabel.AutoSize = true;
            this.Controls.Add(titleLabel);

            // Subtitle
            subTitleLabel = new Label();
            subTitleLabel.Text = "Installing neural core and configuring desktop environment...";
            subTitleLabel.ForeColor = Color.FromArgb(148, 163, 184);
            subTitleLabel.Location = new Point(26, 52);
            subTitleLabel.Size = new Size(390, 22);
            this.Controls.Add(subTitleLabel);

            // Status
            statusLabel = new Label();
            statusLabel.Text = "Initializing installer...";
            statusLabel.ForeColor = Color.FromArgb(34, 211, 238);
            statusLabel.Location = new Point(26, 92);
            statusLabel.Size = new Size(390, 24);
            this.Controls.Add(statusLabel);

            // Progress Bar
            progressBar = new ProgressBar();
            progressBar.Location = new Point(28, 122);
            progressBar.Size = new Size(390, 18);
            progressBar.Style = ProgressBarStyle.Continuous;
            this.Controls.Add(progressBar);

            // Action Button
            actionButton = new Button();
            actionButton.Text = "Cancel";
            actionButton.Location = new Point(318, 165);
            actionButton.Size = new Size(100, 32);
            actionButton.FlatStyle = FlatStyle.Flat;
            actionButton.FlatAppearance.BorderColor = Color.FromArgb(56, 189, 248);
            actionButton.BackColor = Color.FromArgb(20, 24, 38);
            actionButton.ForeColor = Color.White;
            actionButton.Click += (s, e) => Application.Exit();
            this.Controls.Add(actionButton);

            this.Shown += (s, e) => StartInstall();
        }

        private void UpdateStatus(string text, int progress)
        {
            if (this.InvokeRequired)
            {
                this.Invoke(new Action(() => UpdateStatus(text, progress)));
                return;
            }
            statusLabel.Text = text;
            progressBar.Value = Math.Min(100, Math.Max(0, progress));
        }

        private void StartInstall()
        {
            Thread worker = new Thread(() =>
            {
                try
                {
                    UpdateStatus("Initializing secure vault at C:\\ProgramData\\MEERA...", 15);
                    string scriptPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "installer", "setup.ps1");
                    if (!File.Exists(scriptPath))
                    {
                        scriptPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "setup.ps1");
                    }

                    if (!File.Exists(scriptPath))
                    {
                        UpdateStatus("Error: setup.ps1 script not found!", 0);
                        return;
                    }

                    UpdateStatus("Running setup pipeline...", 35);
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = "powershell.exe";
                    psi.Arguments = string.Format("-ExecutionPolicy Bypass -NoProfile -File \"{0}\"", scriptPath);
                    psi.WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory;
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;

                    Process proc = Process.Start(psi);
                    for (int i = 40; i <= 90; i += 5)
                    {
                        if (proc.HasExited) break;
                        UpdateStatus("Installing neural core & runtime (" + i + "%)...", i);
                        Thread.Sleep(1000);
                    }

                    proc.WaitForExit();

                    if (proc.ExitCode == 0)
                    {
                        UpdateStatus("Installation complete! Launching MEERA...", 100);
                        Thread.Sleep(1200);
                        if (this.InvokeRequired)
                        {
                            this.Invoke(new Action(() => Application.Exit()));
                        }
                    }
                    else
                    {
                        UpdateStatus("Setup finished with code: " + proc.ExitCode, 100);
                    }
                }
                catch (Exception ex)
                {
                    UpdateStatus("Error: " + ex.Message, 0);
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm());
        }
    }
}
