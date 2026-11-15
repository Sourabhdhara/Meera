using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace MeeraInstaller
{
    public class PremiumInstaller : Form
    {
        [DllImport("user32.dll")]
        public static extern int SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);
        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();

        [DllImport("Gdi32.dll", EntryPoint = "CreateRoundRectRgn")]
        private static extern IntPtr CreateRoundRectRgn(int nLeftRect, int nTopRect, int nRightRect, int nBottomRect, int nWidthEllipse, int nHeightEllipse);

        private int progressVal = 5;
        private string statusText = "Initializing MEERA Neural Vault...";
        private bool isFinished = false;
        private Image appLogo = null;

        public PremiumInstaller()
        {
            this.FormBorderStyle = FormBorderStyle.None;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.Width = 480;
            this.Height = 280;
            this.BackColor = Color.FromArgb(10, 12, 20);
            this.DoubleBuffered = true;

            // Rounded Window Region
            this.Region = Region.FromHrgn(CreateRoundRectRgn(0, 0, Width, Height, 24, 24));

            // Load App Logo if present
            try
            {
                string logoPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "assets", "icon.png");
                if (!File.Exists(logoPath))
                    logoPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "assets", "icon.png");

                if (File.Exists(logoPath))
                {
                    appLogo = Image.FromFile(logoPath);
                }
            }
            catch {}

            // Drag window anywhere
            this.MouseDown += (s, e) =>
            {
                if (e.Button == MouseButtons.Left)
                {
                    ReleaseCapture();
                    SendMessage(Handle, 0xA1, 0x2, 0);
                }
            };

            this.Shown += (s, e) => RunSetupThread();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            // 1. Dark Void Gradient Background
            using (LinearGradientBrush bgBrush = new LinearGradientBrush(
                new Point(0, 0), new Point(0, Height),
                Color.FromArgb(16, 20, 32), Color.FromArgb(8, 10, 16)))
            {
                g.FillRectangle(bgBrush, ClientRectangle);
            }

            // Radial ambient glow at top
            using (GraphicsPath glowPath = new GraphicsPath())
            {
                glowPath.AddEllipse(Width / 2 - 140, -60, 280, 160);
                using (PathGradientBrush pgb = new PathGradientBrush(glowPath))
                {
                    pgb.CenterColor = Color.FromArgb(35, 232, 121, 249);
                    pgb.SurroundColors = new Color[] { Color.Transparent };
                    g.FillPath(pgb, glowPath);
                }
            }

            // 2. Optical Hairline Border
            using (Pen borderPen = new Pen(Color.FromArgb(50, 255, 255, 255), 1))
            {
                g.DrawRectangle(borderPen, 0, 0, Width - 1, Height - 1);
            }

            // Laser Top-Rim Highlight
            using (Pen rimPen = new Pen(Color.FromArgb(90, 255, 255, 255), 1))
            {
                g.DrawLine(rimPen, 16, 1, Width - 16, 1);
            }

            // 3. Close Button
            Rectangle closeRect = new Rectangle(Width - 36, 12, 24, 24);
            using (Font closeFont = new Font("Segoe UI", 10f, FontStyle.Regular))
            {
                TextRenderer.DrawText(g, "✕", closeFont, closeRect, Color.FromArgb(148, 163, 184), TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }

            // 4. Logo / Icon Display
            int textStartX = 32;
            if (appLogo != null)
            {
                g.DrawImage(appLogo, 30, 26, 44, 44);
                textStartX = 86;
            }

            // 5. Header Typography
            using (Font titleFont = new Font("Segoe UI", 14.5f, FontStyle.Bold))
            {
                TextRenderer.DrawText(g, "MEERA", titleFont, new Point(textStartX, 24), Color.FromArgb(248, 250, 252));
            }

            // Badge
            int badgeX = textStartX + 84;
            Rectangle badgeRect = new Rectangle(badgeX, 29, 64, 18);
            using (GraphicsPath bp = new GraphicsPath())
            {
                bp.AddEllipse(badgeRect.X, badgeRect.Y, 18, 18);
                bp.AddEllipse(badgeRect.Right - 18, badgeRect.Y, 18, 18);
                bp.AddRectangle(new Rectangle(badgeRect.X + 9, badgeRect.Y, badgeRect.Width - 18, 18));
                using (SolidBrush bgb = new SolidBrush(Color.FromArgb(30, 232, 121, 249)))
                {
                    g.FillPath(bgb, bp);
                }
                using (Pen bpen = new Pen(Color.FromArgb(80, 232, 121, 249), 1))
                {
                    g.DrawPath(bpen, bp);
                }
            }
            using (Font badgeFont = new Font("Segoe UI", 8f, FontStyle.Bold))
            {
                TextRenderer.DrawText(g, "INSTALLER", badgeFont, badgeRect, Color.FromArgb(232, 121, 249), TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }

            // Subtitle
            using (Font subFont = new Font("Segoe UI", 9.5f, FontStyle.Regular))
            {
                TextRenderer.DrawText(g, "Autonomous Next-Gen Desktop Companion", subFont, new Point(textStartX, 50), Color.FromArgb(148, 163, 184));
            }

            // 6. Status Label
            using (Font statusFont = new Font("Segoe UI", 10f, FontStyle.Regular))
            {
                Color sc = isFinished ? Color.FromArgb(52, 211, 153) : Color.FromArgb(34, 211, 238);
                TextRenderer.DrawText(g, statusText, statusFont, new Point(32, 115), sc);
            }

            // 7. Progress Track (Modern Glowing Bar)
            int barX = 32;
            int barY = 145;
            int barW = Width - 64;
            int barH = 10;

            // Track background
            using (SolidBrush trackBrush = new SolidBrush(Color.FromArgb(25, 255, 255, 255)))
            {
                g.FillRectangle(trackBrush, barX, barY, barW, barH);
            }

            // Fill Bar with Electric Orchid-Cyan Gradient
            int fillW = (int)((barW * progressVal) / 100.0);
            if (fillW > 0)
            {
                Rectangle fillRect = new Rectangle(barX, barY, fillW, barH);
                using (LinearGradientBrush barBrush = new LinearGradientBrush(
                    fillRect,
                    Color.FromArgb(232, 121, 249),
                    Color.FromArgb(34, 211, 238),
                    LinearGradientMode.Horizontal))
                {
                    g.FillRectangle(barBrush, fillRect);
                }
            }

            // 8. Bottom Information / Action
            using (Font footerFont = new Font("Segoe UI", 8.5f, FontStyle.Regular))
            {
                TextRenderer.DrawText(g, "Protected Neural V8 Engine · ProgramData Vault", footerFont, new Point(32, 230), Color.FromArgb(100, 116, 139));
            }

            // Cancel / Finish Button
            Rectangle btnRect = new Rectangle(Width - 128, 222, 96, 30);
            using (SolidBrush btnBg = new SolidBrush(Color.FromArgb(30, 255, 255, 255)))
            {
                g.FillRectangle(btnBg, btnRect);
            }
            using (Pen btnPen = new Pen(Color.FromArgb(60, 255, 255, 255), 1))
            {
                g.DrawRectangle(btnPen, btnRect);
            }
            using (Font btnFont = new Font("Segoe UI", 9f, FontStyle.Bold))
            {
                string btnTxt = isFinished ? "Launch" : "Cancel";
                Color tc = isFinished ? Color.FromArgb(52, 211, 153) : Color.FromArgb(203, 213, 225);
                TextRenderer.DrawText(g, btnTxt, btnFont, btnRect, tc, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }

            base.OnPaint(e);
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            // Close icon
            if (e.X >= Width - 38 && e.X <= Width - 10 && e.Y >= 10 && e.Y <= 38)
            {
                Application.Exit();
                return;
            }

            // Bottom Right Button
            if (e.X >= Width - 128 && e.X <= Width - 32 && e.Y >= 222 && e.Y <= 252)
            {
                Application.Exit();
                return;
            }

            base.OnMouseClick(e);
        }

        private void SetProgress(string status, int progress)
        {
            if (this.InvokeRequired)
            {
                this.Invoke(new Action(() => SetProgress(status, progress)));
                return;
            }
            statusText = status;
            progressVal = Math.Min(100, Math.Max(0, progress));
            this.Invalidate();
        }

        private void RunSetupThread()
        {
            Thread t = new Thread(() =>
            {
                try
                {
                    SetProgress("Initializing secure vault at C:\\ProgramData\\MEERA...", 15);
                    Thread.Sleep(500);

                    string scriptPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "setup.ps1");
                    if (!File.Exists(scriptPath))
                        scriptPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "installer", "setup.ps1");
                    if (!File.Exists(scriptPath))
                        scriptPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "installer", "setup.ps1");

                    if (!File.Exists(scriptPath))
                    {
                        SetProgress("Error: setup.ps1 script could not be located.", 100);
                        return;
                    }

                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = "powershell.exe";
                    psi.Arguments = string.Format("-ExecutionPolicy Bypass -NoProfile -File \"{0}\"", scriptPath);
                    psi.WorkingDirectory = Path.GetDirectoryName(scriptPath);
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;

                    Process proc = Process.Start(psi);

                    int p = 25;
                    while (!proc.HasExited)
                    {
                        if (p < 90) p += 5;
                        if (p < 50) SetProgress("Extracting neural core into ProgramData...", p);
                        else if (p < 75) SetProgress("Configuring production runtime & dependencies...", p);
                        else SetProgress("Creating Desktop & Start Menu shortcuts...", p);

                        Thread.Sleep(800);
                    }

                    proc.WaitForExit();

                    if (proc.ExitCode == 0)
                    {
                        isFinished = true;
                        SetProgress("MEERA successfully installed! Launching now...", 100);
                        Thread.Sleep(1500);
                        if (this.InvokeRequired)
                        {
                            this.Invoke(new Action(() => Application.Exit()));
                        }
                    }
                    else
                    {
                        SetProgress("Setup finished with exit code: " + proc.ExitCode, 100);
                    }
                }
                catch (Exception ex)
                {
                    SetProgress("Installation error: " + ex.Message, 100);
                }
            });
            t.IsBackground = true;
            t.Start();
        }

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new PremiumInstaller());
        }
    }
}
