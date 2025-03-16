import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

default_css_style = """<style>
div {
    font-size: 12pt;
}
</style>
"""

def _email_login(settings):    
    user = settings["user"]
    pwd = settings["password"]
    
    server = smtplib.SMTP("smtp.gmail.com", 587)
    server.ehlo()
    server.starttls()
    server.login(user, pwd)

    return server


def send_gmail_notification(setting: dict, body_message: str):
    all_html = """<html>
    <head>{style}</head>
    <body>{body_message}</body>
    </html>
    """.format(style=default_css_style, body_message=body_message)

    msg = MIMEMultipart()

    msg['From'] = setting["from_address"]
    msg['To'] = setting["to_address"] if isinstance(setting, str) else ";".join(setting["to_address"])  # type: ignore
    
    msg['Subject'] = setting["subject"]

    # Record the MIME types of both parts - text/plain and text/html.
    msg.attach(MIMEText(all_html, 'html'))
    
    server = _email_login(setting)
    server.sendmail(
        setting["from_address"],  # type: ignore
        setting["to_address"],  # type: ignore
        msg.as_string()
    )
    server.close()
    