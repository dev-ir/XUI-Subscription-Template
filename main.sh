#!/bin/bash

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
plain='\033[0m'
NC='\033[0m'

PROJECT_DIR="/opt/DVHOST"
SERVICE_FILE="/etc/systemd/system/DVHOST_TEMPLATE.service"
VERSION='1.0.3'
[[ $EUID -ne 0 ]] && echo -e "${RED}Fatal error: ${plain} Please run this script with root privilege \n " && exit 1

install_jq() {
    if ! command -v jq &> /dev/null; then
        if command -v apt-get &> /dev/null; then
            echo -e "${RED}jq is not installed. Installing...${NC}"
            sleep 1
            sudo apt-get update
            sudo apt-get install -y jq
        else
            echo -e "${RED}Error: Unsupported package manager. Please install jq manually.${NC}\n"
            read -p "Press any key to continue..."
            exit 1
        fi
    fi
}

loader(){
    install_jq
    SERVER_IP=$(hostname -I | awk '{print $1}')
    SERVER_COUNTRY=$(curl -sS "http://ip-api.com/json/$SERVER_IP" | jq -r '.country')
    SERVER_ISP=$(curl -sS "http://ip-api.com/json/$SERVER_IP" | jq -r '.isp')
}

install_dependencies() {
    echo "Installing Node.js and required tools..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt update
    sudo apt install -y nodejs git
}

clone_project() {
    echo "Cloning the project to $PROJECT_DIR..."
    sudo rm -rf "$PROJECT_DIR"
    sudo git clone https://github.com/dev-ir/xui-subscription-template.git "$PROJECT_DIR"
    cd "$PROJECT_DIR" || exit
}

install_project_dependencies() {
    echo "Installing project dependencies..."
    cd "$PROJECT_DIR" || exit
    npm install
}

create_service() {
    echo "Creating a systemd service for the project..."
    sudo bash -c "cat > $SERVICE_FILE" <<EOL
[Unit]
Description=DVHOST_TEMPLATE Service
After=network.target

[Service]
ExecStart=/usr/bin/node $PROJECT_DIR/server.js
Restart=always
User=$USER
Group=$USER
Environment=PATH=/usr/bin:/usr/local/bin
Environment=NODE_ENV=production
WorkingDirectory=$PROJECT_DIR

[Install]
WantedBy=multi-user.target
EOL
    sudo systemctl daemon-reload
    sudo systemctl enable DVHOST_TEMPLATE
    sudo systemctl start DVHOST_TEMPLATE
}

remove_project() {
    echo "Removing the project and its service..."
    sudo systemctl stop DVHOST_TEMPLATE
    sudo systemctl disable DVHOST_TEMPLATE
    sudo rm -rf "$PROJECT_DIR"
    sudo rm -f "$SERVICE_FILE"
    sudo systemctl daemon-reload
}

edit_config_file(){

    nano /opt/DVHOST/dvhost.config

    sudo systemctl daemon-reload
    sudo systemctl enable DVHOST_TEMPLATE
    sudo systemctl start DVHOST_TEMPLATE
}

menu(){
    
    clear
    echo "+-----------------------------------------------------------------------------------------------+"
    echo "| ██╗  ██╗██╗   ██╗██╗   ████████╗███████╗███╗   ███╗██████╗ ██╗      █████╗ ████████╗███████╗  |"
    echo "| ╚██╗██╔╝██║   ██║██║   ╚══██╔══╝██╔════╝████╗ ████║██╔══██╗██║     ██╔══██╗╚══██╔══╝██╔════╝  |"
    echo "|  ╚███╔╝ ██║   ██║██║      ██║   █████╗  ██╔████╔██║██████╔╝██║     ███████║   ██║   █████╗    |"
    echo "|  ██╔██╗ ██║   ██║██║      ██║   ██╔══╝  ██║╚██╔╝██║██╔═══╝ ██║     ██╔══██║   ██║   ██╔══╝    |"
    echo "| ██╔╝ ██╗╚██████╔╝██║      ██║   ███████╗██║ ╚═╝ ██║██║     ███████╗██║  ██║   ██║   ███████╗  |"
    echo "| ╚═╝  ╚═╝ ╚═════╝ ╚═╝      ╚═╝   ╚══════╝╚═╝     ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝  |"
    echo "+-----------------------------------------------------------------------------------------------+"                                        
    echo -e "| Telegram Channel : ${YELLOW}@DVHOST_CLOUD ${NC} | YouTube : ${RED}youtube.com/@dvhost_cloud${NC} |  Version : ${GREEN} ${VERSION} ${NC} "
    echo "+-----------------------------------------------------------------------------------------------+"            
    # echo "+-----------------------------------------------------------------------------------------------+"                                        
    # echo -e "| VPS Location: ${YELLOW}$SERVER_COUNTRY${NC} | Server IP:${RED} $SERVER_IP ${NC} | Server ISP:${GREEN} $SERVER_ISP${NC}" 
    # echo "+-----------------------------------------------------------------------------------------------+"     
    echo -e "|${GREEN} Server Location:${NC} $SERVER_COUNTRY ${NC}"
    echo -e "|${GREEN} Server IP:${NC} $SERVER_IP ${NC}"
    echo -e "|${GREEN} Server ISP:${NC} $SERVER_ISP ${NC}"
    echo "+-----------------------------------------------------------------------------------------------+"                                        
    echo -e "${YELLOW}|  1  - Install XUI Subscription Template"
    echo -e "|  2  - Edit Configuation"
    echo -e "|  3  - Unistall"
    echo -e "|  0  - Exit${NC}"
    echo "+-----------------------------------------------------------------------------------------------+"                                        
    
    read -p "Please choose an option: " choice
    
    case $choice in
        1)
            install_dependencies
            clone_project
            install_project_dependencies
            create_service
            clear
            echo "+---------------------------------------+"
            echo -e "| ${YELLOW}Installation completed successfully! ${NC} |"
            echo "+---------------------------------------+"

            ;;
            2) edit_config_file ;;
            3) remove_project ;;
            0)
                echo -e "${GREEN}Exiting program...${NC}"
                exit 0
            ;;
            *)
                echo "Not valid"
            ;;
    esac
    
}

loader
menu