# Optionality

A lightweight tool designed to help amateur part-time traders (like me) to get timely information for low-frequency options trading.

## Overview

Optionality is a small, simple yet effective tool aimed at providing a report to enhance your decision-making process in options trading. Whether you're a beginner or an experienced trader, this tool is designed to help you stay informed and make smarter trading decisions.


## [IMPORTANT] Prerequisite
- You need to install [Moomoo OpenD](https://www.moomoo.com/download/OpenAPI) on your local machine. For the usage please refer to its manual.
- You need to have the access to [Moomoo Options Real-Time Quotes](https://qtcard.moomoo.com/intro/api-usoption-realtime?type=16&is_support_buy=1&lang=en-us).

## Usage
1. **Clone the Repository**:
   ```bash
   git clone https://github.com/juchengquan/optionality.git
   ```

2. **Install Dependencies**:
   ```bash
   pip install -e .
   ```

3. **Configure Settings**:
   Edit the `hondings.yaml` or `strategy.yaml` file in `examples` to set up your API keys, preferred data, and alert thresholds.

4. **Run the Application**:
   ```bash
   python main.py -t holdings -f ./_examples/holdings.yaml  # To get information for current holdings 
   ```
   or 
   ```bash
   python main.py -t strategy -f ./_examples/strategy.yaml # To get new information for new strategies
   ```
   The results will be saved locally or sent via email address if set in the config file.


## License

Distributed under the GNU Affero General Public License. See `LICENSE` for more information.

## Acknowledgments
- [yfinance](https://github.com/ranaroussi/yfinance)
- [Moomoo OpenAPI](https://openapi.moomoo.com/moomoo-api-doc/intro/intro.html)